import { test } from "bun:test";
import { isLive } from "./live.ts";

/** True when this host can run sandbox cases: macOS, and not already inside a Xarabot sandbox. */
export const canSandbox: boolean = process.platform === "darwin" && process.env.XARABOT_SANDBOXED !== "1";

/**
 * A test that runs a real sandboxed session. It reports skipped, never
 * passed, on a host that isn't macOS or inside a session (`XARABOT_SANDBOXED=1`).
 */
export const sandboxTest: typeof test = test.skipIf(!canSandbox) as typeof test;

/**
 * A sandboxed session that also talks to real services: it runs only where
 * `sandboxTest` does and under `XARABOT_LIVE=1`, and otherwise reports skipped.
 */
export const liveSandboxTest: typeof test = test.skipIf(!canSandbox || !isLive) as typeof test;
