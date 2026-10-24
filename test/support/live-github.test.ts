import { expect, test } from "bun:test";
import { createFakeForge } from "../../src/adapters/forge/fake/fake-forge.ts";
import { cleanupScratch, DELETE_REF, prefixed, type RawCall } from "./live-github.ts";

const opts = () => ({ signal: AbortSignal.timeout(10_000) });

test("cleanupScratch closes open PRs, tries every delete, and names the failed step", async () => {
  const fake = createFakeForge();
  const touched = new Set<string>();
  const forge = prefixed(fake.forge, "xarabot-test/u/", touched);
  for (const b of ["story/1.1", "story/1.2"]) {
    const sha = fake.control.makeCommit();
    const pushed = await forge.pushBranch({ branch: b, expected_sha: null, sha }, opts());
    expect(pushed.ok).toBe(true);
    const opened = await forge.openPr({ branch: b, base: "main", title: b, body: "" }, opts());
    expect(opened.ok).toBe(true);
  }

  const deletes: string[] = [];
  const raw: RawCall = async (op, path) => {
    expect(op).toBe(DELETE_REF);
    deletes.push(path);
    if (path.includes("story/1.1")) throw new Error("network down");
    return { status: 204, body: null };
  };
  const ledgerBranch = "xarabot/test-x";
  const cleaned = cleanupScratch({ forge: fake.forge, raw, touched, ledgerBranch, signal: () => opts().signal });
  await expect(cleaned).rejects.toThrow(/delete xarabot-test\/u\/story\/1\.1: network down/);

  expect(deletes.sort()).toEqual(["/git/refs/heads/xarabot-test/u/story/1.1", "/git/refs/heads/xarabot-test/u/story/1.2", "/git/refs/heads/xarabot/test-x"]);
  for (const b of touched) {
    const listed = await fake.forge.listPrsByBranch(b, opts());
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.value.length).toBe(1);
    expect(listed.value.every((p) => p.state === "closed")).toBe(true);
  }
});
