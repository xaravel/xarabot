import type { JudgedRuling } from "../core/rulings/effects.ts";
import { rulingReply } from "../core/rulings/rulings.ts";
import type { CallOpts, Forge, ForgeResult, InboxComment, RulingsRead } from "../ports/forge.ts";
import { DEFAULT_CALL_TIMEOUT_MS } from "./ledger-cas.ts";

/**
 * The rulings step (Stories 4.5 and 4.6, FR9, AR29, AD-28): runner code
 * only, run in every `reconcile` run after the ledger work and before the
 * inbox step. It reads the comments on the open inbox issues posted after
 * `cursor` (`coordinator.json`'s `rulings_cursor` in the run's snapshot)
 * through `Forge.readRulings`. When the forge's cursor moved, it judges the
 * batch (`judge`, in order against the run's snapshot), closes the open PR
 * of each valid `rebuild` (a failed close refuses that ruling instead:
 * "closing PR #n failed: …", its effect dropped), then makes one swap
 * (`commit`: the cursor move and every effect, refused once another run
 * moved the cursor), and only after that swap lands posts one 🤖 reply per
 * ruling on its own inbox issue, at most once: a reply that fails is logged
 * and not retried. A comment that is not a ruling gets no reply, but the
 * cursor still moves past it. A read error, a refused swap or a failed
 * reply is logged and skipped: none of them fails or stops the run, and a
 * refused swap leaves the cursor, so the next run judges the same comments
 * against a fresh snapshot. It never throws.
 */

export type AnswerRulingsParams = {
  readonly forge: Forge;
  /** `coordinator.json`'s `rulings_cursor` in the run's snapshot. */
  readonly cursor: string | null;
  /** The batch judged in order against the run's snapshot (`judgeRulings`). */
  readonly judge: (comments: readonly InboxComment[]) => readonly JudgedRuling<InboxComment>[];
  /** The one fenced swap: the cursor from `from` to `to` and every effect of `judged`; `true` once it landed. */
  readonly commit: (from: string | null, to: string, judged: readonly JudgedRuling<InboxComment>[]) => Promise<boolean>;
  readonly log: (line: string) => void;
  /** Ends the step early (between calls) when aborted. */
  readonly signal: AbortSignal;
  /** Each forge call's deadline; default 60 000 ms. */
  readonly callTimeoutMs?: number;
};

export type AnswerRulingsResult = {
  /** The comments read after the cursor. */
  readonly read: number;
  /** Whether `rulings_cursor` moved this run: the swap landed. */
  readonly advanced: boolean;
  /** Whether a swap was tried: `false` when nothing new was read (or the read failed). */
  readonly tried: boolean;
  /** The ruling comments answered, by comment id, in order. */
  readonly answered: readonly string[];
  /** The batch as swapped: a `rebuild` whose close failed is refused, with no effect. Empty when no swap was tried. */
  readonly judged: readonly JudgedRuling<InboxComment>[];
};

export async function answerRulings(p: AnswerRulingsParams): Promise<AnswerRulingsResult> {
  const timeout = p.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  let read = 0;
  let advanced = false;
  let tried = false;
  let judged: JudgedRuling<InboxComment>[] = [];
  const answered: string[] = [];
  const done = (): AnswerRulingsResult => ({ read, advanced, tried, answered, judged });
  const log = (line: string): void => {
    try {
      p.log(`rulings step: ${line}`);
    } catch {
      // Logging is best effort.
    }
  };
  /** One forge call under its own deadline; a throw is a failure with its message. */
  const tryForge = async <T>(what: string, run: (opts: CallOpts) => Promise<ForgeResult<T>>): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }> => {
    let r: ForgeResult<T>;
    try {
      r = await run({ signal: AbortSignal.any([p.signal, AbortSignal.timeout(timeout)]) });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`${what} threw: ${message}; skipped`);
      return { ok: false, message };
    }
    if (r.ok) return { ok: true, value: r.value };
    log(`${what} failed: ${r.error.kind}: ${r.error.message}; skipped`);
    return { ok: false, message: `${r.error.kind}: ${r.error.message}` };
  };

  if (p.signal.aborted) return done();
  const got = await tryForge<RulingsRead>("readRulings", (o) => p.forge.readRulings(p.cursor, o));
  if (!got.ok) {
    log("no ruling read this run");
    return done();
  }
  const { comments, cursor } = got.value;
  read = comments.length;
  if (cursor === null || cursor === p.cursor) {
    if (read > 0) log(`readRulings returned ${read} comment(s) but no new cursor; nothing answered`);
    return done();
  }
  if (p.signal.aborted) return done();
  let batch: JudgedRuling<InboxComment>[];
  try {
    batch = [...p.judge(comments)];
  } catch (e) {
    log(`judging the ${read} comment(s) threw: ${e instanceof Error ? e.message : String(e)}; nothing applied or answered`);
    return done();
  }

  // Each valid rebuild's open PR is closed before the swap; a failed close refuses that ruling.
  for (const [i, j] of batch.entries()) {
    const e = j.effect;
    if (e?.kind !== "ledger" || e.verb !== "rebuild" || e.closePr === null) continue;
    if (p.signal.aborted) return done();
    const pr = e.closePr;
    const closed = await tryForge(`closePr #${pr} (rebuild ${e.unit})`, (o) => p.forge.closePr(pr, o));
    if (closed.ok) {
      log(`closed PR #${pr} for rebuild ${e.unit}`);
      continue;
    }
    batch[i] = { comment: j.comment, judgement: { kind: "refused", verb: "rebuild", unit: e.unit, reason: `closing PR #${pr} failed: ${closed.message}` }, effect: null };
  }

  if (p.signal.aborted) return done();
  tried = true;
  judged = batch;
  try {
    advanced = await p.commit(p.cursor, cursor, batch);
  } catch (e) {
    log(`the rulings swap threw: ${e instanceof Error ? e.message : String(e)}`);
    advanced = false;
  }
  if (!advanced) {
    log(`rulings_cursor not advanced: no ruling applied and no reply to the ${read} comment(s) read this run`);
    return done();
  }
  log(`rulings_cursor advanced past ${read} comment(s)`);
  // Advanced: each reply is tried once; a failed one is not posted again.
  for (const [i, j] of batch.entries()) {
    const c = j.comment;
    if (p.signal.aborted) {
      // The cursor is past them already: these are never answered.
      const left = batch.slice(i).map((x) => x.comment.id);
      log(`aborted after rulings_cursor advanced: ${left.length} comment(s) left unanswered: ${left.join(", ")}`);
      return done();
    }
    const reply = rulingReply(j.judgement, c.url);
    if (reply === null) continue;
    const posted = await tryForge(`inboxComment #${c.issue} (reply to comment ${c.id})`, (o) => p.forge.inboxComment(c.issue, reply, o));
    if (!posted.ok) continue;
    answered.push(c.id);
    log(`answered comment ${c.id} on #${c.issue} by ${c.author ?? "a deleted account"}`);
  }
  return done();
}
