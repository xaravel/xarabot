import type { FakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { parseLedger } from "../../src/core/ledger/codec.ts";
import type { Forge } from "../../src/ports/forge.ts";

/**
 * The step tests' watch on the push fence (Story 3.3, AD-16): `unit`'s
 * `builder_providers` as the ledger on `fake` holds it, read directly so no
 * spied call is counted; `undefined` when there is no such record.
 */
export async function ledgerProviders(fake: FakeForge, unit: string): Promise<readonly string[] | undefined> {
  const snap = await fake.forge.snapshot({ signal: AbortSignal.timeout(5000) });
  if (!snap.ok) throw new Error(snap.error.message);
  const l = parseLedger(snap.value.ledger.files);
  if (!l.ok) throw new Error(l.error.message);
  return l.value.units.get(unit)?.builder_providers;
}

/**
 * `forge` with each `pushBranch` first reading `unit`'s `builder_providers`
 * from the ledger on `fake`: `seen` (default a new list) gets, per push and in
 * order, what the ledger already carried when the branch was about to move.
 */
export function watchPushes(
  forge: Forge,
  fake: FakeForge,
  unit: string,
  seen: (readonly string[] | undefined)[] = [],
): { readonly forge: Forge; readonly seen: (readonly string[] | undefined)[] } {
  return {
    seen,
    forge: {
      ...forge,
      pushBranch: async (lease, o) => {
        seen.push(await ledgerProviders(fake, unit));
        return forge.pushBranch(lease, o);
      },
    },
  };
}
