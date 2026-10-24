/**
 * The canary's commit check (Story 1.20, FR13). Pure: given the text of
 * `git cat-file commit <sha>`, it requires that the author and committer are
 * both `<login>-xarabot[bot]` with a `<id>+<login>-xarabot[bot]@users.noreply.github.com`
 * email, and that the message has no trailer lines (`Key: value` in its last
 * paragraph, after the subject), no `Co-Authored-By` and no "Generated with".
 */

export type CommitCheck = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** `name <email> <epoch> <tz>` of an `author` or `committer` header. */
const PERSON = /^(.*) <([^<>]*)> \d+ [+-]\d{4}$/;
/** A git trailer: a token of letters, digits and `-`, a colon, then a value. */
const TRAILER = /^[A-Za-z0-9][A-Za-z0-9-]*:\s*\S/;

export function checkBotCommit(raw: string, login: string): CommitCheck {
  const fail = (error: string): CommitCheck => ({ ok: false, error });
  const split = raw.indexOf("\n\n");
  if (split === -1) return fail("commit: no blank line between the headers and the message");
  const headers = raw.slice(0, split).split("\n");
  const message = raw.slice(split + 2);

  const name = `${login}-xarabot[bot]`;
  const emailEnd = `+${name}@users.noreply.github.com`;
  for (const role of ["author", "committer"] as const) {
    const lines = headers.filter((h) => h.startsWith(`${role} `));
    if (lines.length !== 1) return fail(`commit: ${lines.length} ${role} headers, expected 1`);
    const m = PERSON.exec((lines[0] as string).slice(role.length + 1));
    if (m === null) return fail(`commit: unreadable ${role} header ${JSON.stringify(lines[0])}`);
    const [, who, email] = m as unknown as [string, string, string];
    if (who !== name) return fail(`commit: ${role} is ${JSON.stringify(who)}, not ${JSON.stringify(name)}`);
    if (!email.endsWith(emailEnd) || !/^[1-9][0-9]*\+/.test(email)) {
      return fail(`commit: ${role} email ${JSON.stringify(email)} is not <id>${emailEnd}`);
    }
  }

  if (/co-authored-by/i.test(message)) return fail("commit: the message has a Co-Authored-By marker");
  if (/generated with/i.test(message)) return fail('commit: the message has a "Generated with" marker');
  const paragraphs = message
    .replace(/\s+$/, "")
    .split(/\n[ \t]*\n/)
    .filter((p) => p.trim() !== "");
  if (paragraphs.length > 1) {
    const last = (paragraphs[paragraphs.length - 1] as string).split("\n");
    const trailers = last.filter((l) => TRAILER.test(l));
    if (trailers.length > 0) return fail(`commit: the message has trailer lines: ${trailers.map((t) => JSON.stringify(t)).join(", ")}`);
  }
  return { ok: true };
}
