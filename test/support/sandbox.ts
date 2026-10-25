import { describe, test } from "bun:test";
import { isLive } from "./live.ts";

/** True inside a Xarabot sandboxed session (`XARABOT_SANDBOXED=1`). */
export const isSandboxed: boolean = process.env.XARABOT_SANDBOXED === "1";

/** True when this host can run sandbox cases: macOS, and not already inside a Xarabot sandbox. */
export const canSandbox: boolean = process.platform === "darwin" && !isSandboxed;

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

/**
 * A test that needs host access a session's profile denies: binding a
 * socket, `ps`, signalling or inspecting another process, resolving `/tmp`.
 * It runs on the host, outside a sandbox, and reports skipped inside a
 * session (`XARABOT_SANDBOXED=1`).
 */
export const hostTest: typeof test = test.skipIf(isSandboxed) as typeof test;

/** A `describe` whose every case is a `hostTest`: it reports skipped inside a session. */
export const hostDescribe: typeof describe = describe.skipIf(isSandboxed) as typeof describe;
