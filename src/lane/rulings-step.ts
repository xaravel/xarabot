import { rulingReply, type RulingJudgement } from "../core/rulings/rulings.ts";
import type { CallOpts, Forge, ForgeResult, InboxComment, RulingsRead } from "../ports/forge.ts";
import { DEFAULT_CALL_TIMEOUT_MS } from "./ledger-cas.ts";

/**
 * The rulings step (Story 4.5, FR9, AR29, AD-28): runner code only, run in
 * every `reconcile` run after the ledger work and before the inbox step. It
 * reads the comments on the open inbox issues posted after `cursor`
 * (`coordinator.json`'s `rulings_cursor` in the run's snapshot) through
 * `Forge.readRulings`. When the forge's cursor moved, it first advances
 * `rulings_cursor` from `cursor` to it (`advance`, one fenced ledger swap
 * that refuses once another run moved it), and only after that swap lands
 * judges each comment and posts one 🤖 reply per ruling on its own inbox
 * issue, at most once: a reply that fails is logged and not retried. A
 * comment that is not a ruling gets no reply, but the cursor still moves
 * past it. A read error, a refused swap or a failed reply is logged and
 * skipped: none of them fails or stops the run. It applies no ruling (Story
 * 4.6) and never throws.
 */

export type AnswerRulingsParams = {
  readonly forge: Forge;
  /** `coordinator.json`'s `rulings_cursor` in the run's snapshot. */
  readonly cursor: string | null;
  /** One comment judged against the run's snapshot (`judgeRuling`). */
  readonly judge: (comment: InboxComment) => RulingJudgement;
  /** The fenced `rulings_cursor` swap from `from` to `to`; `true` once it landed. */
  readonly advance: (from: string | null, to: string) => Promise<boolean>;
  readonly log: (line: string) => void;
  /** Ends the step early (between calls) when aborted. */
  readonly signal: AbortSignal;
  /** Each forge call's deadline; default 60 000 ms. */
  readonly callTimeoutMs?: number;
};

export type AnswerRulingsResult = {
  /** The comments read after the cursor. */
  readonly read: number;
  /** Whether `rulings_cursor` moved this run. */
  readonly advanced: boolean;
  /** The ruling comments answered, by comment id, in order. */
  readonly answered: readonly string[];
};

export async function answerRulings(p: AnswerRulingsParams): Promise<AnswerRulingsResult> {
  const timeout = p.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  let read = 0;
  let advanced = false;
  const answered: string[] = [];
  const done = (): AnswerRulingsResult => ({ read, advanced, answered });
  const log = (line: string): void => {
    try {
      p.log(`rulings step: ${line}`);
    } catch {
      // Logging is best effort.
    }
  };
  /** One forge call under its own deadline; a throw is a failure with its message. */
  const tryForge = async <T>(what: string, run: (opts: CallOpts) => Promise<ForgeResult<T>>): Promise<T | undefined> => {
    let r: ForgeResult<T>;
    try {
      r = await run({ signal: AbortSignal.any([p.signal, AbortSignal.timeout(timeout)]) });
    } catch (e) {
      log(`${what} threw: ${e instanceof Error ? e.message : String(e)}; skipped`);
      return undefined;
    }
    if (r.ok) return r.value;
    log(`${what} failed: ${r.error.kind}: ${r.error.message}; skipped`);
    return undefined;
  };

  if (p.signal.aborted) return done();
  const got: RulingsRead | undefined = await tryForge("readRulings", (o) => p.forge.readRulings(p.cursor, o));
  if (got === undefined) {
    log("no ruling read this run");
    return done();
  }
  read = got.comments.length;
  if (got.cursor === null || got.cursor === p.cursor) {
    if (read > 0) log(`readRulings returned ${read} comment(s) but no new cursor; nothing answered`);
    return done();
  }
  if (p.signal.aborted) return done();
  try {
    advanced = await p.advance(p.cursor, got.cursor);
  } catch (e) {
    log(`advanceRulingsCursor threw: ${e instanceof Error ? e.message : String(e)}`);
    advanced = false;
  }
  if (!advanced) {
    log(`rulings_cursor not advanced: no reply to the ${read} comment(s) read this run`);
    return done();
  }
  log(`rulings_cursor advanced past ${read} comment(s)`);
  // Advanced: each reply is tried once; a failed one is not posted again.
  for (const [i, c] of got.comments.entries()) {
    if (p.signal.aborted) {
      // The cursor is past them already: these are never answered.
      const left = got.comments.slice(i).map((x) => x.id);
      log(`aborted after rulings_cursor advanced: ${left.length} comment(s) left unanswered: ${left.join(", ")}`);
      return done();
    }
    let reply: string | null;
    try {
      reply = rulingReply(p.judge(c), c.url);
    } catch (e) {
      log(`judging comment ${c.id} on #${c.issue} threw: ${e instanceof Error ? e.message : String(e)}; no reply`);
      continue;
    }
    if (reply === null) continue;
    const text = reply;
    const posted = await tryForge(`inboxComment #${c.issue} (reply to comment ${c.id})`, (o) => p.forge.inboxComment(c.issue, text, o));
    if (posted === undefined) continue;
    answered.push(c.id);
    log(`answered comment ${c.id} on #${c.issue} by ${c.author ?? "a deleted account"}`);
  }
  return done();
}
