import { EMPTY_INBOX_BODY, type OwnerDigest } from "../core/inbox/render-digest.ts";
import type { Forge, InboxIssue } from "../ports/forge.ts";
import { bestEffortOps, message } from "./session.ts";

/**
 * The inbox step (Story 4.2, FR9, AR24): runner code only, run in every
 * `reconcile` run after the ledger work. It enumerates every open inbox
 * issue (an owner's inbox is the lowest-numbered one assigned to them),
 * opens one for each owner with items who has none, and rewrites a body only
 * when it differs from the rendered one, so an owner whose items all cleared
 * gets `EMPTY_INBOX_BODY`, and so does every open inbox issue the runner
 * opened that is no owner's inbox (unassigned, or a later one of an
 * owner's), so no stale body stays; an issue a person opened and labelled is
 * never cleared (Epic 4 retro item 7). When the daily digest is due it first stamps
 * `digest_posted_at` (`stamp`, a fenced `coordinator.json` edit that refuses
 * once today's digest is stamped), and only after a successful stamp posts
 * one comment per non-empty inbox: `@<owner>`, the item count and the issue
 * link. Forge errors are logged and skipped (`bestEffortOps`, which the
 * rulings step shares): they never fail or stop the run, and a post that
 * fails after the stamp is not retried that day. It never throws.
 */

export type SyncInboxesParams = {
  readonly forge: Forge;
  /** The rendered digests (`renderDigest`): owner → body and item count, for owners with items. */
  readonly digests: ReadonlyMap<string, OwnerDigest>;
  /** Whether today's digest slot passed with no digest posted. */
  readonly digestDue: boolean;
  /** The fenced `digest_posted_at` stamp; `true` once it landed. Called only when `digestDue`. */
  readonly stamp: () => Promise<boolean>;
  readonly log: (line: string) => void;
  /** Ends the step early (between calls) when aborted. */
  readonly signal: AbortSignal;
  /** Each forge call's deadline; default 60 000 ms. */
  readonly callTimeoutMs?: number;
};

export type SyncInboxesResult = {
  /** Owners whose inbox was created this run. */
  readonly opened: readonly string[];
  /** Inbox issues whose body was rewritten (items or cleared). */
  readonly written: readonly number[];
  /** Whether `digest_posted_at` was stamped this run. */
  readonly stamped: boolean;
  /** Inbox issues a digest mention was posted on. */
  readonly mentioned: readonly number[];
};

/** The digest mention on `owner`'s inbox: `@<owner>`, the item count and the issue link. */
export function digestMention(owner: string, count: number, url: string): string {
  return `🤖 @${owner} Xarabot daily digest: ${count} ${count === 1 ? "item waits" : "items wait"} on you in ${url}.`;
}

export async function syncInboxes(p: SyncInboxesParams): Promise<SyncInboxesResult> {
  const { log, call } = bestEffortOps("inbox", p);
  const opened: string[] = [];
  const written: number[] = [];
  const mentioned: number[] = [];
  let stamped = false;
  const done = (): SyncInboxesResult => ({ opened, written, stamped, mentioned });
  if (p.signal.aborted) return done();
  const got = await call("inboxes", (o) => p.forge.inboxes(o));
  if (!got.ok) {
    log("no inbox rewritten and no digest posted this run");
    return done();
  }
  const listed = got.value;
  /** Each owner's inbox: the lowest-numbered open one assigned to them, by lowercased login. */
  const inboxOf = new Map<string, InboxIssue>();
  for (const issue of [...listed].sort((a, b) => a.number - b.number)) {
    if (issue.owner === null) continue;
    const key = issue.owner.toLowerCase();
    if (!inboxOf.has(key)) inboxOf.set(key, issue);
  }

  /** `true` when the issue holds `body`: it already did, or the rewrite succeeded. */
  const rewrite = async (issue: InboxIssue, body: string, why: string): Promise<boolean> => {
    if (issue.body === body) return true;
    const set = await call(`setInboxBody #${issue.number}`, (o) => p.forge.setInboxBody(issue.number, body, o));
    if (!set.ok) return false;
    written.push(issue.number);
    log(`#${issue.number}: ${why}`);
    return true;
  };

  /** The owners with items whose inbox holds their digest, for the mentions. */
  const ready: { readonly owner: string; readonly count: number; readonly issue: InboxIssue }[] = [];
  for (const [owner, digest] of [...p.digests].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (p.signal.aborted) return done();
    let issue = inboxOf.get(owner.toLowerCase());
    if (issue === undefined) {
      const made = await call(`openInbox ${owner}`, (o) => p.forge.openInbox(owner, o));
      if (!made.ok) continue;
      issue = made.value;
      opened.push(owner);
      log(`opened #${issue.number} for ${owner}`);
    }
    // A mention links the issue, so it goes only to an inbox whose body is today's.
    if (await rewrite(issue, digest.body, `${digest.count} item(s) for ${owner}`)) ready.push({ owner, count: digest.count, issue });
  }
  const owners = new Set([...p.digests.keys()].map((o) => o.toLowerCase()));
  for (const [key, issue] of [...inboxOf].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (p.signal.aborted) return done();
    if (owners.has(key)) continue;
    await rewrite(issue, EMPTY_INBOX_BODY, `cleared for ${issue.owner ?? "nobody"}: nothing waits on them`);
  }
  // An issue the runner opened that is no owner's inbox holds no items; a body left from before is cleared. A person's is theirs.
  const current = new Set([...inboxOf.values()].map((i) => i.number));
  for (const issue of [...listed].sort((a, b) => a.number - b.number)) {
    if (p.signal.aborted) return done();
    if (current.has(issue.number) || !issue.by_runner) continue;
    const why = issue.owner === null ? "unassigned" : `#${inboxOf.get(issue.owner.toLowerCase())?.number} is ${issue.owner}'s inbox`;
    await rewrite(issue, EMPTY_INBOX_BODY, `cleared: not an owner's inbox (${why})`);
  }

  if (!p.digestDue || p.signal.aborted) return done();
  try {
    stamped = await p.stamp();
  } catch (e) {
    log(`digest stamp threw: ${message(e)}`);
    stamped = false;
  }
  if (!stamped) {
    log("digest_posted_at not stamped: no digest mention this run");
    return done();
  }
  log("digest_posted_at stamped");
  // Stamped: each post is tried once; a failed one waits for tomorrow's digest.
  for (const r of ready) {
    if (p.signal.aborted) return done();
    if (r.count === 0) continue;
    const posted = await call(`inboxComment #${r.issue.number}`, (o) => p.forge.inboxComment(r.issue.number, digestMention(r.owner, r.count, r.issue.url), o));
    if (!posted.ok) continue;
    mentioned.push(r.issue.number);
    log(`digest mention for ${r.owner} on #${r.issue.number}`);
  }
  return done();
}
