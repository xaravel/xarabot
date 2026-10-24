import { describe, expect, test } from "bun:test";
import {
  BACKOFF_KINDS,
  deadlinePassed,
  FORGE_ERROR_KINDS,
  FORGE_OPERATIONS,
  forgeErr,
  forgeOk,
  isBackoffKind,
  isLaneStopKind,
  LANE_STOP_KINDS,
  rateLimited,
  type Forge,
  type ForgeErrorKind,
  type ForgeSnapshot,
} from "../../src/ports/forge.ts";
import type { AssembleInput } from "../../src/core/next/snapshot.ts";

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type True<T extends true> = T;

type Operations =
  | "snapshot"
  | "ledgerSwap"
  | "pushBranch"
  | "openPr"
  | "updatePr"
  | "closePr"
  | "listPrsByBranch"
  | "comment"
  | "checks"
  | "enqueue"
  | "dequeue"
  | "queueState"
  | "alert"
  | "prefetch";

type AR33Kinds = "conflict" | "not-fast-forward" | "auth" | "forbidden" | "rate-limited" | "not-found" | "uninstalled" | "transient";

/* Compile-time: `keyof Forge` is exactly the operations, with no approve or merge; the kinds are AR33's. */
type _PortChecks = [
  True<Equal<keyof Forge, Operations>>,
  True<Equal<"approve" extends keyof Forge ? true : false, false>>,
  True<Equal<"merge" extends keyof Forge ? true : false, false>>,
  True<Equal<ForgeErrorKind, AR33Kinds>>,
  True<Equal<(typeof FORGE_OPERATIONS)[number], keyof Forge>>,
];

/* Compile-time: a snapshot's parts feed `assembleSnapshot`. */
function feed(s: ForgeSnapshot): Pick<AssembleInput, "now" | "main_sha" | "tree" | "files" | "blob_shas" | "ledger_tip" | "ledger_files" | "prs"> {
  return {
    now: s.now,
    main_sha: s.main.sha,
    tree: s.main.tree,
    files: s.main.files,
    blob_shas: s.main.blob_shas,
    ledger_tip: s.ledger.tip,
    ledger_files: s.ledger.files,
    prs: s.prs,
  };
}

describe("Forge port", () => {
  test("lists the operations and the eight AR33 error kinds", () => {
    expect([...FORGE_OPERATIONS].sort()).toEqual(
      ["alert", "checks", "closePr", "comment", "dequeue", "enqueue", "ledgerSwap", "listPrsByBranch", "openPr", "prefetch", "pushBranch", "queueState", "snapshot", "updatePr"],
    );
    expect([...FORGE_ERROR_KINDS].sort()).toEqual(
      ["auth", "conflict", "forbidden", "not-fast-forward", "not-found", "rate-limited", "transient", "uninstalled"],
    );
    expect(typeof feed).toBe("function");
  });

  test("lane-stopping and back-off kinds", () => {
    expect([...LANE_STOP_KINDS]).toEqual(["auth", "forbidden", "uninstalled"]);
    expect([...BACKOFF_KINDS]).toEqual(["rate-limited", "transient"]);
    expect(FORGE_ERROR_KINDS.filter(isLaneStopKind)).toEqual(["auth", "forbidden", "uninstalled"]);
    expect(FORGE_ERROR_KINDS.filter(isBackoffKind)).toEqual(["rate-limited", "transient"]);
  });

  test.each([
    [7, 7],
    [1.2, 2],
    [-3, 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
  ])("rateLimited(%p) carries retry_after %p", (input, seconds) => {
    expect(rateLimited(input, "slow")).toEqual({ ok: false, error: { kind: "rate-limited", message: "slow", retry_after: seconds } });
  });

  test("helpers", () => {
    expect(forgeOk(1)).toEqual({ ok: true, value: 1 });
    expect(forgeErr("conflict", "m")).toEqual({ ok: false, error: { kind: "conflict", message: "m" } });
    expect(deadlinePassed("checks")).toEqual({ ok: false, error: { kind: "transient", message: "checks: deadline passed" } });
  });
});
