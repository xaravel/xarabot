import { isOpenItem } from "../next/epic-gates.ts";
import { capText, FORGE_TEXT_LIMITS, sanitizeAgentText } from "../sanitize.ts";
import { unitFileName, type UnitRecord } from "../schemas/ledger.ts";
import type { Snapshot } from "../schemas/snapshot.ts";
import { openDeferred } from "./deferred.ts";

/**
 * The owners' inbox bodies (Story 4.2, FR9): one body per owner with items,
 * built from one snapshot and `main`'s Story specs.
 *
 * - A record parked `awaiting-approval` or `blocked` goes to its
 *   `park.inbox_owner`; every `needs-approval` record and every `blocked`
 *   `human-live-step` record goes to the Maintainer (`config.maintainer`).
 * - The Maintainer's inbox also lists the waiting checkpoint gos: each Epic
 *   in `graph.checkpoints` whose retro is done and which has no
 *   `checkpoint.go`. A bootstrapped Epic counts as retro done (Story 4.4).
 *   When such an Epic has no retro record, its item reads
 *   `Epic <N> is bootstrapped` and has no age. The inbox also lists
 *   the rejected retros with no go (each naming its open Maintainer-routed
 *   items as its course-correction items), the open (`open`, `in-progress`
 *   or `waiting`) retro items routed to the Maintainer, each once, naming
 *   its Epic and aged from the Epic's `retro.recorded_at` (Story 4.3), the
 *   unmanifested Story headings of Epics not bootstrapped, and each
 *   unresolved deferred entry of a Story spec on `main` (`openDeferred`).
 *   An `open` and a `waiting` Maintainer item list alike: items recorded
 *   before Story 4.3 stay `open`.
 *
 * Each item shows a link, an age in whole days (`<1d` under a day; none when
 * nothing dates it) and its fixed verb only: `/xarabot go checkpoint:<N>`,
 * `/xarabot go retro:<N>`, `/xarabot done|defer retro-item:<id>`, or
 * `/xarabot approve <unit>` for `needs-approval`. A blocked item's
 * `park.text` is quoted under it. Sections come in a fixed order and items
 * sorted; the only clock text is the day ages, so a body changes at most
 * once a day from ageing alone. Free text goes through `sanitizeAgentText`,
 * so a body never @-mentions anyone, and it is capped at
 * `FORGE_TEXT_LIMITS.body`. Pure.
 *
 * Story 4.6: an item whose unit, text (`what`) and start time (`since`)
 * match a dismissal in the snapshot's `coordinator.json` is left out; the
 * same item comes back with another text or start time (a new instance)
 * lists again. `inboxInstance` gives a unit's item as a dismissal names it,
 * and `inboxOwner` the owner whose inbox lists it, by these same rules (the
 * rulings' authority, Story 4.5).
 */

/** The body of an inbox with nothing in it. */
export const EMPTY_INBOX_BODY = "🤖 Xarabot inbox: nothing waits on you.\n";

/** The ledger branch a unit record with no PR links into. */
const LEDGER_BRANCH = "xarabot/claims";
const DAY_MS = 24 * 60 * 60 * 1000;

export type OwnerDigest = {
  /** The inbox body. */
  readonly body: string;
  /** How many items it lists. */
  readonly count: number;
};

export type RenderDigestInput = {
  readonly snapshot: Snapshot;
  /** `main`'s file texts the snapshot read, by repo path: the Story specs among them. */
  readonly files: Readonly<Record<string, string>>;
  /** The repo's web URL, `https://github.com/<owner>/<name>`, with no trailing `/`. */
  readonly repoUrl: string;
};

/** The sections, in body order. */
const SECTIONS = [
  ["awaiting", "Awaiting approval"],
  ["needs", "Needs approval"],
  ["blocked", "Blocked"],
  ["checkpoint", "Checkpoint gos"],
  ["rejected", "Rejected retros"],
  ["item", "Retro items for the Maintainer"],
  ["unmanifested", "Story headings with no manifest"],
  ["deferred", "Deferred entries"],
] as const;

type Section = (typeof SECTIONS)[number][0];

type Item = {
  readonly section: Section;
  /** The sort key within its section. */
  readonly key: string;
  readonly label: string;
  readonly url: string;
  readonly what: string;
  /** When the item began, or `null` when nothing dates it. */
  readonly since: string | null;
  readonly verb: string | null;
  /** Lines shown under the item, already sanitized. */
  readonly under: readonly string[];
};

/** Free text as an inbox shows it: sanitized (no @mention, no closing keyword), on one line. */
function oneLine(text: string): string {
  return sanitizeAgentText(text).replace(/\s+/g, " ").trim();
}

/** A label for a Markdown link's text: no `[`, `]` or backticks to break it. */
function linkText(text: string): string {
  return text.replace(/[[\]`]/g, "");
}

/** The whole days from `since` to `now`: `<1d` under one day. */
export function ageText(now: string, since: string): string {
  const days = Math.floor((Date.parse(now) - Date.parse(since)) / DAY_MS);
  return Number.isFinite(days) && days >= 1 ? `${days}d` : "<1d";
}

/** Orders keys with their digit runs compared as numbers, so `retro:10` sorts after `retro:9`. */
function naturalCompare(a: string, b: string): number {
  const pa = a.split(/(\d+)/);
  const pb = b.split(/(\d+)/);
  for (let i = 0; i < Math.min(pa.length, pb.length); i += 1) {
    const x = pa[i] as string;
    const y = pb[i] as string;
    if (x === y) continue;
    if (i % 2 === 1) {
      const d = Number(x) - Number(y);
      if (d !== 0) return Math.sign(d);
    }
    return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}

function blobUrl(repoUrl: string, branch: string, path: string): string {
  return `${repoUrl}/blob/${branch.split("/").map(encodeURIComponent).join("/")}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** A parked record's link: its PR, else its ledger record. */
function recordUrl(repoUrl: string, r: UnitRecord): string {
  return r.pr !== null ? `${repoUrl}/pull/${r.pr}` : blobUrl(repoUrl, LEDGER_BRANCH, `units/${unitFileName(r.unit)}`);
}

/**
 * The owner whose inbox lists a parked record: the Maintainer for a
 * `needs-approval` or a `blocked` `human-live-step` park, else its
 * `park.inbox_owner`; `null` for a record not parked.
 */
export function parkedOwner(snapshot: Snapshot, r: UnitRecord): string | null {
  const park = r.park;
  if (r.state !== "parked" || park === null) return null;
  if (park.kind === "needs-approval" || (park.kind === "blocked" && park.reason === "human-live-step")) return snapshot.config.maintainer;
  return park.inbox_owner;
}

/** The items of one parked record, with the owner whose inbox lists it; `null` for any other record. */
function parkedItem(snapshot: Snapshot, repoUrl: string, r: UnitRecord): { readonly owner: string; readonly item: Item } | null {
  const park = r.park;
  const owner = parkedOwner(snapshot, r);
  if (park === null || owner === null) return null;
  const base = { key: r.unit, label: r.unit, url: recordUrl(repoUrl, r), since: r.heartbeat_at };
  switch (park.kind) {
    case "needs-approval":
      return { owner, item: { ...base, section: "needs", what: "needs approval", verb: `/xarabot approve ${r.unit}`, under: [] } };
    case "awaiting-approval":
      // A graph change's delta is posted: it waits on the Maintainer's approval, in their inbox (`inbox_owner`).
      const what = park.graph_posted !== undefined ? "awaiting approval (graph change)" : "awaiting approval";
      return { owner, item: { ...base, section: "awaiting", what, verb: null, under: [] } };
    case "blocked": {
      const reason = park.reason ?? "other";
      const text = park.text === undefined ? "" : sanitizeAgentText(park.text).trim();
      const under = text === "" ? [] : text.split(/\r?\n/).map((l) => (l.trim() === "" ? ">" : `> ${l.trimEnd()}`));
      return { owner, item: { ...base, section: "blocked", what: `blocked \`${reason}\``, verb: null, under } };
    }
  }
}

/** The items only the Maintainer's inbox lists. */
function maintainerItems(input: RenderDigestInput): Item[] {
  const { snapshot, repoUrl, files } = input;
  const config = snapshot.config;
  const items: Item[] = [];
  const gatesUrl = blobUrl(repoUrl, "main", config.retro_gates_path);
  const epics = Object.entries(snapshot.retro_gates.epics)
    .map(([key, entry]) => ({ epic: Number(key), entry }))
    .sort((a, b) => a.epic - b.epic);
  const bootstrapped = new Set(config.bootstrapped_epics);

  if (snapshot.graph.ok) {
    for (const n of snapshot.graph.value.checkpoints) {
      const entry = snapshot.retro_gates.epics[String(n)];
      const retro = entry?.retro;
      // The go is due once the retro is done: recorded, or the Epic bootstrapped (AD-12).
      if ((retro === undefined && !bootstrapped.has(n)) || entry?.checkpoint !== undefined) continue;
      items.push({
        section: "checkpoint",
        key: `checkpoint:${n}`,
        label: `checkpoint:${n}`,
        url: gatesUrl,
        what: retro === undefined ? `Epic ${n} is bootstrapped` : `Epic ${n}'s retro is recorded (${retro.verdict})`,
        since: retro?.recorded_at ?? null,
        verb: `/xarabot go checkpoint:${n}`,
        under: [],
      });
    }
  }

  for (const { epic, entry } of epics) {
    const routed = (entry.items ?? []).filter((i) => i.route === "maintainer" && isOpenItem(i.status));
    const retro = entry.retro;
    if (retro !== undefined && retro.verdict === "rejected" && retro.go === undefined) {
      items.push({
        section: "rejected",
        key: `retro:${epic}`,
        label: `retro:${epic}`,
        url: gatesUrl,
        what: "rejected, no go",
        since: retro.recorded_at,
        verb: `/xarabot go retro:${epic}`,
        under: routed.map((i) => `- course correction: retro-item:${i.id}`),
      });
    }
    for (const i of routed) {
      items.push({
        section: "item",
        key: `retro-item:${i.id}`,
        label: `retro-item:${i.id}`,
        url: gatesUrl,
        what: `Epic ${epic} · ${i.status}${i.blocking ? ", blocking" : ""}: ${oneLine(i.text)}`,
        since: retro?.recorded_at ?? null,
        verb: `/xarabot done|defer retro-item:${i.id}`,
        under: [],
      });
    }
  }

  if (snapshot.graph.ok) {
    for (const u of snapshot.graph.value.unmanifested) {
      if (bootstrapped.has(u.epic)) continue;
      items.push({
        section: "unmanifested",
        key: `story:${u.id}`,
        label: `story:${u.id}`,
        url: `${blobUrl(repoUrl, "main", config.epics_path)}#L${u.line}`,
        what: `Epic ${u.epic}'s heading has no manifest`,
        since: null,
        verb: null,
        under: [],
      });
    }
  }

  const deferred = openDeferred(config.story_spec_path, Object.keys(files), files);
  for (const d of deferred.open) {
    const summary = oneLine(d.summary);
    items.push({
      section: "deferred",
      key: d.id,
      label: d.id,
      url: blobUrl(repoUrl, "main", d.spec),
      what: summary === "" ? "deferred" : `deferred: ${summary}`,
      since: d.created,
      verb: null,
      under: [],
    });
  }
  return items;
}

function renderItem(now: string, item: Item): string[] {
  const parts = [`[${linkText(oneLine(item.label))}](${item.url})`, item.what];
  if (item.since !== null) parts.push(ageText(now, item.since));
  if (item.verb !== null) parts.push(`\`${item.verb}\``);
  return [`- ${parts.join(" · ")}`, ...item.under.map((l) => `  ${l}`)];
}

function renderBody(now: string, items: readonly Item[]): string {
  const lines = [`🤖 Xarabot inbox: ${items.length} ${items.length === 1 ? "item waits" : "items wait"} on you.`, ""];
  for (const [section, title] of SECTIONS) {
    const list = items.filter((i) => i.section === section).sort((a, b) => naturalCompare(a.key, b.key));
    if (list.length === 0) continue;
    lines.push(`### ${title} (${list.length})`, "");
    for (const item of list) lines.push(...renderItem(now, item));
    lines.push("");
  }
  lines.push("Each reconcile run rewrites this list; ages are in whole days.", "");
  return capText(lines.join("\n"), FORGE_TEXT_LIMITS.body);
}

/** Every inbox item of the snapshot with the owner whose inbox lists it, dismissed ones included. */
function ownedItems(input: RenderDigestInput): { readonly owner: string; readonly item: Item }[] {
  const { snapshot, repoUrl } = input;
  const maintainer = snapshot.config.maintainer;
  const out: { owner: string; item: Item }[] = maintainerItems(input).map((item) => ({ owner: maintainer, item }));
  for (const r of snapshot.ledger.units) {
    const parked = parkedItem(snapshot, repoUrl, r);
    if (parked !== null) out.push(parked);
  }
  return out;
}

/**
 * The inbox item `unit` names in `snapshot`, dismissed or not, with the
 * owner whose inbox lists it; `undefined` when no inbox lists it. Deferred
 * entries are not units, so no file is read.
 */
function unitItem(snapshot: Snapshot, unit: string): { readonly owner: string; readonly item: Item } | undefined {
  return ownedItems({ snapshot, files: {}, repoUrl: "" }).find((o) => o.item.key === unit);
}

/** An inbox item as a dismissal names it: its text and start time, as the digest shows them. */
export type InboxInstance = { readonly subject: string; readonly since: string | null };

/** The inbox item `unit` names in `snapshot`, as a dismissal records it (Story 4.6), or `null` when no inbox lists it. */
export function inboxInstance(snapshot: Snapshot, unit: string): InboxInstance | null {
  const found = unitItem(snapshot, unit);
  return found === undefined ? null : { subject: found.item.what, since: found.item.since };
}

/**
 * The owner whose inbox lists `unit` (Story 4.5), dismissed or not, or
 * `null` when none does: a parked record's owner (`parkedOwner`), else the
 * Maintainer for a waiting checkpoint go, a rejected retro with no go, an
 * open Maintainer-routed retro item or an unmanifested Story heading outside
 * `bootstrapped_epics`.
 */
export function inboxOwner(snapshot: Snapshot, unit: string): string | null {
  return unitItem(snapshot, unit)?.owner ?? null;
}

/** Whether a dismissal in the snapshot's `coordinator.json` names this very item. */
function dismissed(snapshot: Snapshot, item: Item): boolean {
  return (snapshot.ledger.coordinator?.dismissals ?? []).some((d) => d.unit === item.key && d.subject === item.what && d.since === item.since);
}

/**
 * One body per owner with at least one item, keyed by login (owners
 * compared case-insensitively, under the first spelling met: the
 * Maintainer's own first), in login order. A dismissed item is left out.
 */
export function renderDigest(input: RenderDigestInput): Map<string, OwnerDigest> {
  const { snapshot } = input;
  const maintainer = snapshot.config.maintainer;
  const byOwner = new Map<string, { login: string; items: Item[] }>([[maintainer.toLowerCase(), { login: maintainer, items: [] }]]);
  const add = (owner: string, item: Item) => {
    const key = owner.toLowerCase();
    const slot = byOwner.get(key) ?? { login: owner, items: [] };
    slot.items.push(item);
    byOwner.set(key, slot);
  };
  for (const { owner, item } of ownedItems(input)) if (!dismissed(snapshot, item)) add(owner, item);
  const out = new Map<string, OwnerDigest>();
  for (const key of [...byOwner.keys()].sort()) {
    const { login, items } = byOwner.get(key) as { login: string; items: Item[] };
    if (items.length === 0) continue;
    out.set(login, { body: renderBody(snapshot.now, items), count: items.length });
  }
  return out;
}
