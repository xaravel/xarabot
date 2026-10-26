/**
 * The sanitizer for agent text bound for the forge (AR16): an agent's
 * `summary` or `body` first has credentials redacted (the given secrets and
 * token-shaped strings, each replaced by `[REDACTED]`), then loses
 * attribution trailers, "Generated with" markers, a final trailer block and
 * closing keywords with their references, and each @mention loses its `@`.
 * Last, with `max`, text longer than `max` UTF-16 code units is cut and ends
 * with a marker. Pure and total; text with none of these comes back
 * byte-identical.
 */

/** What a redacted credential becomes. */
export const REDACTED = "[REDACTED]";

/** What ends a text `capText` cut. */
export const TRUNCATION_MARKER = "\n\n[truncated by xarabot]";

/** The forge's text limits, kept below GitHub's own (UTF-16 code units). */
export const FORGE_TEXT_LIMITS = { title: 256, body: 65_536, comment: 65_536 } as const;

export type SanitizeOpts = {
  /** Exact credentials to redact; each is trimmed, and an empty one is ignored. */
  readonly secrets?: readonly string[];
  /** The longest the result may be, in UTF-16 code units. */
  readonly max?: number;
};

/** Token-shaped strings, always redacted: a PEM private key, `sk-…`, GitHub, AWS, Slack, JWT, npm, GitLab, Google API and Stripe live keys. */
const TOKEN_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}/g,
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_-])xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
  /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
  /(?<![A-Za-z0-9_])(?:sk|rk)_live_[A-Za-z0-9]{10,}/g,
];

/** The given secrets, trimmed, without empty ones or repeats, longest first. */
const exactSecrets = (secrets: readonly string[]): string[] => [...new Set(secrets.map((s) => s.trim()).filter((s) => s !== ""))].sort((a, b) => b.length - a.length);

/** `text` with every given secret (longest first) and every token-shaped string replaced by `[REDACTED]`. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of exactSecrets(secrets)) out = out.split(secret).join(REDACTED);
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, REDACTED);
  return out;
}

/**
 * True when `text` holds a given secret or a token-shaped string: something
 * `redactSecrets` would redact. The write check's `credential` class (Epic 2
 * retro item 20) refuses a committed blob for which this holds.
 */
export function holdsCredential(text: string, secrets: readonly string[] = []): boolean {
  // `search` ignores a global pattern's `lastIndex`, so the shared patterns keep no state.
  return exactSecrets(secrets).some((s) => text.includes(s)) || TOKEN_SHAPES.some((shape) => text.search(shape) !== -1);
}

/**
 * `text` when it is at most `max` UTF-16 code units long; else cut, never
 * inside a surrogate pair, and ended with `TRUNCATION_MARKER`, the whole at
 * most `max` long.
 */
export function capText(text: string, max: number): string {
  if (!(text.length > max)) return text;
  const limit = Math.max(0, Math.floor(max));
  let keep = Math.max(0, limit - TRUNCATION_MARKER.length);
  const last = keep > 0 ? text.charCodeAt(keep - 1) : 0;
  if (last >= 0xd800 && last <= 0xdbff) keep -= 1;
  return `${text.slice(0, keep)}${TRUNCATION_MARKER}`.slice(0, limit);
}

const ATTRIBUTION =
  /^\s*(?:co-authored-by|signed-off-by|acked-by|reviewed-by|tested-by|reported-by|suggested-by|helped-by|assisted-by|generated-by|cc)\s*:/i;

const GENERATED_WITH = /^[\s>*_#-]*(?:\u{1F916}\s*)?generated with\b/iu;

/** `Token: value`, with optional whitespace around `:` as git takes it; a URL (`https://…`) is not one. */
const TRAILER = /^[A-Za-z0-9][A-Za-z0-9-]*[ \t]*:(?!\/\/)[ \t]*\S/;
const CONTINUATION = /^[ \t]+\S/;
const BLANK = /^\s*$/;

const REFERENCE =
  "(?:[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\\/[A-Za-z0-9._-]+#[0-9]+|#[0-9]+|GH-[0-9]+|https?:\\/\\/[^\\s]+?\\/(?:issues|pull)\\/[0-9]+)(?![\\w/-])";
const CLOSING_PHRASE = `(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)(?::[ \\t]*|[ \\t]+)${REFERENCE}`;
/** At the start of a line the phrase takes one space after it; elsewhere one space before it. */
const CLOSING = new RegExp(`^${CLOSING_PHRASE}(?: )?|(?: )?(?<![\\w])${CLOSING_PHRASE}`, "gi");

const MENTION = /(?<!\w)@+([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)?)/g;

/** Drops the final trailer block (last paragraph, not the first, all trailer lines); true when it did. */
function dropTrailerBlock(lines: string[]): boolean {
  let end = lines.length;
  while (end > 0 && BLANK.test(lines[end - 1] as string)) end -= 1;
  let start = end;
  while (start > 0 && !BLANK.test(lines[start - 1] as string)) start -= 1;
  if (start === end) return false;
  let first = 0;
  while (first < lines.length && BLANK.test(lines[first] as string)) first += 1;
  if (start <= first) return false;
  const block = lines.slice(start, end);
  if (!TRAILER.test(block[0] as string)) return false;
  if (!block.every((l) => TRAILER.test(l) || CONTINUATION.test(l))) return false;
  lines.splice(start);
  return true;
}

export function sanitizeAgentText(text: string, opts: SanitizeOpts = {}): string {
  // Redaction runs first, on the whole text, so no later rule can split a credential.
  const redacted = redactSecrets(text, opts.secrets);
  let removed = false;
  const lines: string[] = [];
  for (const line of redacted.split("\n")) {
    if (ATTRIBUTION.test(line) || GENERATED_WITH.test(line)) {
      removed = true;
      continue;
    }
    // Repeat until stable, so a removal cannot uncover another mention or keyword.
    let current = line;
    let lineRemoved = false;
    for (;;) {
      const stripped = current.replace(CLOSING, "");
      if (stripped !== current) lineRemoved = true;
      const next = stripped.replace(MENTION, "$1");
      if (next === current) break;
      current = next;
    }
    if (lineRemoved) {
      removed = true;
      if (BLANK.test(current)) continue;
    }
    lines.push(current);
  }
  if (dropTrailerBlock(lines)) removed = true;
  if (removed) {
    while (lines.length > 0 && BLANK.test(lines[lines.length - 1] as string)) lines.pop();
  }
  const out = lines.join("\n");
  return opts.max === undefined ? out : capText(out, opts.max);
}
