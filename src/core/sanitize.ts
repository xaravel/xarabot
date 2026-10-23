/**
 * The sanitizer for agent text bound for the forge (AR16): an agent's
 * `summary` or `body` loses attribution trailers, "Generated with" markers,
 * a final trailer block and closing keywords with their references, and each
 * @mention loses its `@`. Pure and total; text with none of these comes back
 * byte-identical.
 */

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

export function sanitizeAgentText(text: string): string {
  let removed = false;
  const lines: string[] = [];
  for (const line of text.split("\n")) {
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
  return lines.join("\n");
}
