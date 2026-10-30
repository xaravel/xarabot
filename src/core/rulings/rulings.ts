import { inboxOwner, parkedOwner } from "../inbox/render-digest.ts";
import { isOpenItem } from "../next/epic-gates.ts";
import { capText, FORGE_TEXT_LIMITS, sanitizeAgentText } from "../sanitize.ts";
import { isUnitId, unitKind, type UnitRecord } from "../schemas/ledger.ts";
import { RETRO_ITEM_ID_PATTERN, type RetroItem } from "../schemas/retro-gates.ts";
import type { Snapshot, SnapshotManifest } from "../schemas/snapshot.ts";
import { storyKey } from "../story-id.ts";

/**
 * The owners' rulings (Story 4.5, FR9, AR29, AD-28): a comment on an inbox
 * issue that reads `/xarabot <verb> <unit-id>`. This module parses one
 * (`parseRuling`), judges it against one snapshot (`judgeRuling`: who may
 * rule it, then whether it applies) and words the 🤖 reply (`rulingReply`).
 * It applies nothing: each verb's effect is built in `effects.ts` (Story
 * 4.6). Pure.
 *
 * Authority (logins compared case-insensitively): `go`, `approve`, `block`,
 * `unblock`, `done` and `defer` count only from the Maintainer
 * (`config.maintainer`), checked before the target; `rebuild`, `release` and
 * `dismiss` count from the item's owner or the Maintainer, checked after the
 * target, which finds the owner. The owner is the one whose inbox lists the
 * unit, by `renderDigest`'s own rules (`inboxOwner`, `parkedOwner`): a
 * `parked` `needs-approval` or `blocked` `human-live-step` record is the
 * Maintainer's, any other parked record its `park.inbox_owner`'s, and every
 * other inbox item the Maintainer's.
 */

export { inboxOwner };

export const RULING_VERBS = ["go", "approve", "block", "unblock", "done", "defer", "rebuild", "release", "dismiss"] as const;
export type RulingVerb = (typeof RULING_VERBS)[number];

/** The verbs only the Maintainer may rule. */
export const MAINTAINER_VERBS = ["go", "approve", "block", "unblock", "done", "defer"] as const satisfies readonly RulingVerb[];
/** The verbs the item's owner or the Maintainer may rule. */
export const OWNER_VERBS = ["rebuild", "release", "dismiss"] as const satisfies readonly RulingVerb[];

/** The most code points of comment text a reply echoes. */
export const ECHO_MAX = 120;

export type ParsedRuling =
  /** Not a ruling at all: ignored, with no reply. */
  | { readonly kind: "none" }
  | { readonly kind: "malformed"; readonly reason: string }
  | { readonly kind: "ruling"; readonly verb: RulingVerb; readonly unit: string };

/** The comment a ruling arrives in: its author (`null` for a deleted account) and body. */
export type RulingComment = { readonly author: string | null; readonly body: string };

export type RulingJudgement =
  /** Not a ruling: no reply. */
  | { readonly kind: "ignored" }
  /** A ruling that does not count or does not apply; `verb` and `unit` are `null` when it did not parse. */
  | { readonly kind: "refused"; readonly verb: RulingVerb | null; readonly unit: string | null; readonly reason: string }
  /** A ruling that counts: by `author`, on `unit`, whose inbox item is `owner`'s. */
  | { readonly kind: "valid"; readonly verb: RulingVerb; readonly unit: string; readonly author: string; readonly owner: string };

const PREFIX = /^\/xarabot(?:\s|$)/;

const isVerb = (word: string): word is RulingVerb => (RULING_VERBS as readonly string[]).includes(word);
const isMaintainerVerb = (verb: RulingVerb): boolean => (MAINTAINER_VERBS as readonly string[]).includes(verb);

/**
 * Comment text as a reply echoes it: sanitized (`sanitizeAgentText`: no
 * credential, no @mention), with no backtick or `@`, on one line, and at
 * most `ECHO_MAX` code points.
 */
export function echoText(text: string): string {
  const clean = sanitizeAgentText(text).replace(/[`@]/g, "").replace(/\s+/g, " ").trim();
  const points = Array.from(clean);
  return points.length <= ECHO_MAX ? clean : `${points.slice(0, ECHO_MAX - 1).join("")}…`;
}

/** Echoed text in code style; `(blank)` when nothing is left of it. */
const code = (text: string): string => {
  const e = echoText(text);
  return e === "" ? "(blank)" : `\`${e}\``;
};

/**
 * One comment body as a ruling. A body that, trimmed, does not start with
 * `/xarabot` and then whitespace or its end is not one (a 🤖 reply, a quote,
 * plain text). Otherwise it must be exactly `/xarabot <verb> <unit-id>` on
 * one line, else it is malformed with the reason: no verb, an unknown verb,
 * no unit id, not a unit id (`isUnitId`), or text after the unit id.
 */
export function parseRuling(body: string): ParsedRuling {
  const text = body.trim();
  if (!PREFIX.test(text)) return { kind: "none" };
  const [first = "", ...more] = text.split(/\r\n|\r|\n/);
  const words = first.trim().split(/\s+/);
  const verb = words[1];
  if (verb === undefined) return { kind: "malformed", reason: "the ruling names no verb" };
  if (!isVerb(verb)) return { kind: "malformed", reason: `${code(verb)} is not a verb (${RULING_VERBS.join(", ")})` };
  const unit = words[2];
  if (unit === undefined) return { kind: "malformed", reason: `\`${verb}\` names no unit id` };
  if (!isUnitId(unit)) return { kind: "malformed", reason: `${code(unit)} is not a unit id` };
  if (words.length > 3 || more.join("\n").trim() !== "") return { kind: "malformed", reason: `there is text after the unit id ${code(unit)}` };
  return { kind: "ruling", verb, unit };
}

const sameLogin = (a: string | null, b: string): boolean => a !== null && a.toLowerCase() === b.toLowerCase();

type Target = { readonly ok: true; readonly owner: string } | { readonly ok: false; readonly reason: string };

const fail = (reason: string): Target => ({ ok: false, reason });

const recordOf = (snapshot: Snapshot, unit: string): UnitRecord | undefined => snapshot.ledger.units.find((r) => r.unit === unit);

/** The part of a unit id after its kind. */
export const bodyOf = (unit: string): string => unit.slice(unit.indexOf(":") + 1);

/** The manifest on `main` of the Story `story:<id>` names, or `undefined` (for any other unit too). */
export function manifestOf(snapshot: Snapshot, unit: string): SnapshotManifest | undefined {
  if (unitKind(unit) !== "story") return undefined;
  const key = storyKey(bodyOf(unit));
  return snapshot.manifests.find((m) => storyKey(m.story_id) === key);
}

/** The retro item `retro-item:<id>` names, in the Epic its id names. */
function listedItem(snapshot: Snapshot, verb: RulingVerb, unit: string): { readonly ok: true; readonly item: RetroItem } | { readonly ok: false; readonly reason: string } {
  if (unitKind(unit) !== "retro-item") return { ok: false, reason: `\`${verb}\` applies only to a retro item` };
  const id = bodyOf(unit);
  const epic = RETRO_ITEM_ID_PATTERN.exec(id)?.[1] as string;
  const item = snapshot.retro_gates.epics[epic]?.items?.find((i) => i.id === id);
  if (item === undefined) return { ok: false, reason: `${snapshot.config.retro_gates_path} lists no ${unit} under Epic ${epic}` };
  return { ok: true, item };
}

function goTarget(snapshot: Snapshot, unit: string): Target {
  const maintainer = snapshot.config.maintainer;
  const body = bodyOf(unit);
  const entry = snapshot.retro_gates.epics[body];
  switch (unitKind(unit)) {
    case "checkpoint":
      if (!snapshot.graph.ok) return fail("the Epic graph does not resolve");
      if (!snapshot.graph.value.checkpoints.includes(Number(body))) return fail(`Epic ${body} is not a checkpoint`);
      if (entry?.checkpoint !== undefined) return fail(`${unit} already has a go`);
      return { ok: true, owner: maintainer };
    case "retro":
      if (entry?.retro === undefined) return fail(`Epic ${body} has no retro verdict recorded`);
      if (entry.retro.verdict !== "rejected") return fail(`${unit}'s verdict is ${entry.retro.verdict}, not rejected`);
      if (entry.retro.go !== undefined) return fail(`${unit} already has a go`);
      return { ok: true, owner: maintainer };
    default:
      return fail("`go` applies only to a checkpoint or a retro");
  }
}

/** Whether `verb` applies to `unit` in the snapshot, and whose inbox item it is. */
function target(snapshot: Snapshot, verb: RulingVerb, unit: string): Target {
  const maintainer = snapshot.config.maintainer;
  const r = recordOf(snapshot, unit);
  switch (verb) {
    case "go":
      return goTarget(snapshot, unit);
    case "approve":
      if (r === undefined) return fail(`${unit} has no ledger record`);
      if (r.state !== "parked" || r.park?.kind !== "needs-approval") return fail(`${unit} is not parked needs-approval`);
      if (manifestOf(snapshot, unit) === undefined) return fail(`${unit} has no manifest on main`);
      return { ok: true, owner: maintainer };
    case "block":
    case "unblock": {
      const found = listedItem(snapshot, verb, unit);
      if (!found.ok) return fail(found.reason);
      const wanted = verb === "block";
      if (found.item.blocking === wanted) return fail(`${unit} is already ${wanted ? "blocking" : "not blocking"}`);
      return { ok: true, owner: maintainer };
    }
    case "done": {
      const found = listedItem(snapshot, verb, unit);
      if (!found.ok) return fail(found.reason);
      if (found.item.status === "done") return fail(`${unit} is already done`);
      return { ok: true, owner: maintainer };
    }
    case "defer": {
      const found = listedItem(snapshot, verb, unit);
      if (!found.ok) return fail(found.reason);
      const status = found.item.status;
      if (!isOpenItem(status)) return fail(`${unit} is ${status}, not open, in-progress or waiting`);
      return { ok: true, owner: maintainer };
    }
    case "rebuild":
    case "release": {
      if (r === undefined) return fail(`${unit} has no ledger record`);
      const owner = parkedOwner(snapshot, r);
      if (owner === null) return fail(`${unit} is ${r.state}, not parked`);
      return { ok: true, owner };
    }
    case "dismiss": {
      const owner = inboxOwner(snapshot, unit);
      return owner === null ? fail(`no inbox lists ${unit}`) : { ok: true, owner };
    }
  }
}

/**
 * One comment judged against one snapshot: ignored when it is not a ruling;
 * refused (with the reason) when it is malformed, its author may not rule
 * it, or it does not apply; else valid. Nothing is applied.
 */
export function judgeRuling(snapshot: Snapshot, comment: RulingComment): RulingJudgement {
  const parsed = parseRuling(comment.body);
  if (parsed.kind === "none") return { kind: "ignored" };
  if (parsed.kind === "malformed") return { kind: "refused", verb: null, unit: null, reason: parsed.reason };
  const { verb, unit } = parsed;
  const maintainer = snapshot.config.maintainer;
  const refused = (reason: string): RulingJudgement => ({ kind: "refused", verb, unit, reason });
  if (isMaintainerVerb(verb) && !sameLogin(comment.author, maintainer)) return refused(`only the Maintainer (${maintainer}) may rule \`${verb}\``);
  const t = target(snapshot, verb, unit);
  if (!t.ok) return refused(t.reason);
  const author = comment.author;
  if (author === null || (!sameLogin(author, t.owner) && !sameLogin(author, maintainer))) {
    return refused(
      sameLogin(t.owner, maintainer)
        ? `only the Maintainer (${maintainer}) may rule \`${verb}\` on ${unit}`
        : `only ${t.owner} or the Maintainer (${maintainer}) may rule \`${verb}\` on ${unit}`,
    );
  }
  return { kind: "valid", verb, unit, author, owner: t.owner };
}

/** A link target as a reply carries it: no whitespace, parenthesis or backtick to break the Markdown. */
const linkTarget = (url: string): string => url.replace(/[\s()<>`]/g, "");

/**
 * The 🤖 reply to a judged ruling, posted on its own inbox issue and linking
 * the ruling comment (`url`); `null` for a comment that is not a ruling.
 * Echoed text goes through `echoText`, so a reply never @-mentions anyone;
 * the whole is capped at `FORGE_TEXT_LIMITS.comment`.
 */
export function rulingReply(judgement: RulingJudgement, url: string): string | null {
  const link = `[comment](${linkTarget(url)})`;
  switch (judgement.kind) {
    case "ignored":
      return null;
    case "valid":
      return capText(
        `🤖 Ruling acknowledged: \`/xarabot ${judgement.verb} ${echoText(judgement.unit)}\` from ${echoText(judgement.author)} (${link}).`,
        FORGE_TEXT_LIMITS.comment,
      );
    case "refused": {
      const reason = sanitizeAgentText(judgement.reason).replace(/@/g, "").replace(/\s+/g, " ").trim().replace(/\.+$/, "");
      return capText(`🤖 Ruling not applied (${link}): ${reason}. Nothing changed.`, FORGE_TEXT_LIMITS.comment);
    }
  }
}
