import { test } from "bun:test";

/** True when this host can run sandbox cases: macOS, and not already inside a Xarabot sandbox. */
export const canSandbox: boolean = process.platform === "darwin" && process.env.XARABOT_SANDBOXED !== "1";

/**
 * A test that runs a real sandboxed session. It reports skipped, never
 * passed, on a host that isn't macOS or inside a session (`XARABOT_SANDBOXED=1`).
 */
export const sandboxTest: typeof test = test.skipIf(!canSandbox) as typeof test;
