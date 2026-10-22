import { expect } from "bun:test";
import { liveTest } from "../support/live.ts";

// Run directly by test/live.test.ts; not named *.test.ts so plain `bun test` skips it.
liveTest("live sample", () => {
  expect(process.env.XARABOT_LIVE).toBe("1");
});
