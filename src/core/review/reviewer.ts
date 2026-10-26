import type { AdapterName } from "../schemas/policy.ts";

/**
 * Session vendors and the reviewer choice (FR8, AR17, AR18; AD-16), pure.
 * Every step that pushes an agent-made commit adds its lane's vendor to the
 * unit's `builder_providers[]` before the push; the reviewer is the first
 * allowed adapter of `claude`, `codex` from a vendor not in that set, else
 * the first allowed one (a same-vendor review). A policy that allows
 * neither has no reviewer.
 */

/** The model vendors 0.x sessions come from: lowercase, OpenRouter-style ids (AD-16). */
export const PROVIDERS = ["anthropic", "openai"] as const;

/** A model vendor id (AD-16). */
export type Provider = (typeof PROVIDERS)[number];

/** The agents 0.x can compose a session for: every adapter name but `pi`, deferred to v1 (AD-16, Story 3.2). */
export type SessionAdapter = Exclude<AdapterName, "pi">;

/** The order the reviewer is picked in: the first allowed adapter of these (AD-16). */
export const REVIEWER_ORDER: readonly SessionAdapter[] = ["claude", "codex"];

/** Each session adapter's one vendor in 0.x. */
const ADAPTER_PROVIDER: Readonly<Record<SessionAdapter, Provider>> = {
  claude: "anthropic",
  codex: "openai",
};

/**
 * A session's vendor (AD-16): its model's. In 0.x each adapter's models all
 * come from one vendor (`claude` is Anthropic, `codex` is OpenAI), so the
 * model never changes it; v1 `pi` reads its `<provider>/<id>` model here.
 */
export function sessionProvider(session: { readonly adapter: SessionAdapter; readonly model: string }): Provider {
  return ADAPTER_PROVIDER[session.adapter];
}

/**
 * The vendor names runner-11 and earlier wrote to `builder_providers[]`:
 * adapter names, before Story 3.3 made the set hold vendors (AR17).
 */
const LEGACY_PROVIDER: ReadonlyMap<string, Provider> = new Map([
  ["claude", "anthropic"],
  ["codex", "openai"],
]);

/**
 * A unit's `builder_providers[]` as vendors (AR17, AD-16): each legacy
 * adapter name (`claude`, `codex`) mapped to its vendor, every other entry
 * as it is. Only for reading: a stored record keeps its names.
 */
export function readProviders(set: readonly string[]): string[] {
  return set.map((p) => LEGACY_PROVIDER.get(p) ?? p);
}

/**
 * `set` with `p` added, sorted and without duplicates (AD-16): a unit's
 * `builder_providers[]` only ever grows.
 */
export function addProvider(set: readonly string[], p: Provider): string[] {
  return [...new Set([...set, p])].sort();
}

/** The reviewer for a unit (AD-16): its adapter, and whether its vendor built none of the unit. */
export type ReviewerChoice = { readonly adapter: SessionAdapter; readonly crossVendor: boolean };

/**
 * The reviewer for a unit built by `builderProviders` under a policy that
 * allows `allowed` (AD-16): the first of `REVIEWER_ORDER` that `allowed`
 * lists and whose vendor is not in the set (cross-vendor); else the first of
 * `REVIEWER_ORDER` that `allowed` lists (same-vendor); `null` when `allowed`
 * lists neither. The set is read through `readProviders`, so a legacy
 * `claude` or `codex` counts as its vendor. `pi` is never a reviewer, and an
 * unknown vendor in the set matches no adapter.
 */
export function chooseReviewer(builderProviders: readonly string[], allowed: readonly AdapterName[]): ReviewerChoice | null {
  const built = readProviders(builderProviders);
  const candidates = REVIEWER_ORDER.filter((a) => allowed.includes(a));
  const cross = candidates.find((a) => !built.includes(ADAPTER_PROVIDER[a]));
  if (cross !== undefined) return { adapter: cross, crossVendor: true };
  const same = candidates[0];
  return same === undefined ? null : { adapter: same, crossVendor: false };
}
