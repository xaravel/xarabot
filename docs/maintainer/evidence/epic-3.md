# Epic 3 live evidence

The Maintainer's record of Epic 3's live run on the Xarabot host, for `retro:3` (AR14, AR21). It follows `self-host.md` § "Epic 3's live evidence (Story 3.6)".

There were two runs on 2026-10-26, and both are kept:
- **Run 1** found three codex defects in the sandbox. They were fixed by retro items 31, 32 and 34.
- **Run 2** passed every command except one codex resume case. Its cause is found, and the fix is routed as retro item 35.

Codex stays out of `unattended_adapters` until item 35 ships and the codex live checks pass. The policy is claude-only, as it has been since self-hosting.

Sources:
- the command outputs in `~/epic3-live/` (run 1) and `~/epic3-live-2/` (run 2) on the host, as `edanisko-xarabot`;
- the scratch repo's PRs;
- two diagnosis sessions run by the Maintainer's session: stack samples of the hung codex processes, and C probes of the sandbox profile.

## Setup

- **Host:** the Xarabot host (`m1`), as `edanisko-xarabot`, outside any sandbox (`XARABOT_SANDBOXED` unset).
- **Tools:** `bun 1.4.3`, `claude 2.1.309 (Claude Code)`, `codex-cli 0.163.0`.
- **Credentials:** the Claude token (`vendors/claude/oauth-token`) and one codex credential (`vendors/codex/auth.json`), both mode 600.
- **Scratch repo:** `xaravel/xarabot-scratch` was re-seeded with the stand-in `bmad-build-auto` skill and `AGENTS.md` through its merge queue (scratch PR #18), before run 1.

## Run 1: 2026-10-26, 06:52:29Z to 08:25:14Z, `main` 261a7bc (with Story 3.6; no tag)

| Command | Result | Time |
|---|---|---|
| `XARABOT_LIVE=1 XARABOT_LIVE_GITHUB_REPO=xaravel/xarabot-scratch XARABOT_LIVE_GITHUB_LOGIN=edanisko bun test test/e2e/cross-vendor.test.ts` | 73 pass, 0 skip, 3 fail | 5198 s |
| `bun test test/sandbox/macos.test.ts test/sandbox/proxy.test.ts` | 182 pass, 2 skip, 0 fail | 31 s |
| `XARABOT_LIVE=1 bun test test/contracts/agent.codex.contract.test.ts` | 10 pass, 0 skip, 1 fail | 28 s |
| `XARABOT_LIVE=1 bun test test/adapters/agent/codex/codex-live.test.ts` | 2 pass, 0 skip, 3 fail | 277 s |
| `bun test test/sandbox/` | 326 pass, 3 skip, 0 fail | 31 s |

**What passed.** The claude-only case (`live cross-vendor: a claude-only policy …`) passed:
```
cross-vendor single-vendor: 1-6-xv-single-vendor-d5d6076b PR #21 merged at c85510d918a15e52821d963304a921f260c46aba; builder_providers ["anthropic"]; attempts 0, loopbacks 0, ci_fixes 0
  🤖 Story 1.6: same-vendor review by claude (claude-opus-5-5) of c85510d918a15e52821d963304a921f260c46aba.
```
The codex-live `auth.json` and proxy-hosts cases also passed: `credentialRewritten: false`, and only `chatgpt.com:443` and `ab.chatgpt.com:443` were allowed.

**Each failure.** Every one involves codex, and each is listed with its cause and what changed.

1. **Codex tool calls were refused.** `Agent contract: codex > live: a smoke session writes a result and reports its usage`, and `codex live > outcome mapping: …`, failed with ENOENT on `result.json`, although codex exited 0. The same cause sank `live cross-vendor: codex builds Story 1.6, claude reviews it, …` at `step "the run shows case codex"`. The unit log says "the permission mode refused the tool host needed to read `bmad-build-auto`".
   - **Cause:** codex 0.163.0 runs its shell and file tools through `vendor/<target>/bin/codex-code-mode-host`, which the Seatbelt profile did not allow. Codex's stderr said: `failed to spawn code-mode host …: Operation not permitted (os error 1)`.
   - **Changed:** retro item 31 (#190) lets a codex session read and run its own native package folder.
2. **Codex hung at startup.** `live cross-vendor: claude builds Story 1.6, codex reviews it, …` and `… a later agent change after a passed review is reviewed again before its enqueue` failed at `step "laneRun to its trailing wait": laneRun did not exit within 40 min`. Both unit logs stop at `review step: run 1 (fresh) starts`. Their codex reviewers were left running for up to 1 h 47 m and were stopped by exact PID (68836, 92331). `codex live > resume: …` also hit its 240 s limit in this run.
   - **Cause:** reqwest's proxy setup blocked in `bootstrap_look_up3` on `com.apple.SystemConfiguration.configd`, which the profile did not list. A stack sample of PID 92331 showed this.
   - **Changed:** retro item 34 (#198, Maintainer decision 2026-10-26) allows that lookup.
3. **Subagent tokens were not counted.** `codex live > subagent tokens: …` failed with `Expected: > 71777, Received: 71777`.
   - **Cause:** codex 0.163.0 writes the parent's `session_meta` second in each child's file, and the parser kept the last one, so no child was found.
   - **Changed:** retro item 32 (#192) reads the first `session_meta` only.

Retro items 31, 32 and 34 are on `main`. The lanes do not run codex: the policy is claude-only. So run 2 tested them from `main` rather than from a runner tag.

## Run 2: 2026-10-26, 11:53:29Z to 12:27:13Z, `main` c490ad1 (items 31, 32 and 34; runner-12 is at ec45f7e, and items 34 and later are in no tag yet)

| Command | Result | Time |
|---|---|---|
| `XARABOT_LIVE=1 XARABOT_LIVE_GITHUB_REPO=xaravel/xarabot-scratch XARABOT_LIVE_GITHUB_LOGIN=edanisko bun test test/e2e/cross-vendor.test.ts` | 76 pass, 0 skip, 0 fail | 1651 s |
| `bun test test/sandbox/macos.test.ts test/sandbox/proxy.test.ts` | 185 pass, 2 skip, 0 fail | 31 s |
| `XARABOT_LIVE=1 bun test test/contracts/agent.codex.contract.test.ts` | 11 pass, 0 skip, 0 fail | 24 s |
| `XARABOT_LIVE=1 bun test test/adapters/agent/codex/codex-live.test.ts` | 4 pass, 0 skip, 1 fail | 286 s |
| `bun test test/sandbox/` | 334 pass, 3 skip, 0 fail | 31 s |

**The cross-vendor cases.** All four live cases passed, and each merged at its reviewed head:
```
cross-vendor claude: 1-6-xv-claude-1fc86549 PR #22 merged at d0b5193c6db8c8310e3809279e56ab85111afec8; builder_providers ["anthropic"]; attempts 0, loopbacks 0, ci_fixes 0
  🤖 Story 1.6: cross-vendor review by codex (gpt-6.1-sol) of d0b5193c6db8c8310e3809279e56ab85111afec8.
cross-vendor codex: 1-6-xv-codex-207d54b0 PR #23 merged at d10cd832e7a413636b24b89428567833528e0639; builder_providers ["openai"]; attempts 0, loopbacks 0, ci_fixes 0
  🤖 Story 1.6: cross-vendor review by claude (claude-opus-5-5) of d10cd832e7a413636b24b89428567833528e0639.
cross-vendor later-change: 1-6-xv-later-change-dce5eedb PR #24 merged at 6c427c98908104c25c285d4bb54ba6f5839914c1; builder_providers ["anthropic"]; attempts 1, loopbacks 0, ci_fixes 1; held enqueue at b43152eed24e2ca29f2f0d57d2f30048bffe7ee2
  🤖 Story 1.6: cross-vendor review by codex (gpt-6.1-sol) of b43152eed24e2ca29f2f0d57d2f30048bffe7ee2.
  🤖 Story 1.6: cross-vendor review by codex (gpt-6.1-sol) of 6c427c98908104c25c285d4bb54ba6f5839914c1.
cross-vendor single-vendor: 1-6-xv-single-vendor-4daf397e PR #25 merged at ce6e6cdf6d35d99f5b44b20f41388561d9df492b; builder_providers ["anthropic"]; attempts 0, loopbacks 0, ci_fixes 0
  🤖 Story 1.6: same-vendor review by claude (claude-opus-5-5) of ce6e6cdf6d35d99f5b44b20f41388561d9df492b.
```

**What codex-live printed:**
- **Subagent tokens (now passing):** the parent's `turn.completed` is input 4735, output 108, cacheRead 67072, and two children were found (2022/5/12032 and 230/5/13824). The parsed input is 6987, the parent's plus the children's.
- `credentialRewritten: false`.
- **Proxy hosts:** `allow ab.chatgpt.com:443`, `allow chatgpt.com:443`, and `deny` for the four `sdmntpr*.oaiusercontent.com:443` hosts.

**The one failure.** `codex live > resume: a run that wrote no result is resumed with codex exec … resume <thread_id> and writes it` failed after 244.9 s. The fresh run exited 0, but the resume ended with `exitCode` null at the test's limit.
- **Cause:** the diagnosis looked at the same hang in a later run of this case (PID 28531). There, the resume had finished its turn and written `{"result":"ok"}`, then hung at exit. Codex's file watcher stops at teardown, and its `notify-rs fsevents loop` thread blocks in `FSEvents_connect → bootstrap_look_up3 → mach_msg2_trap` on `com.apple.FSEvents`, which the profile does not list.
- **What else the probes showed:**
  - On this host (macOS 27.0.1), a Mach lookup the profile denies *and reports* never returns.
  - With `(with no-report)` the same denial returns in 18–38 ms.
  - Kernel-side denials (file, network) return at once.
  - The hang is intermittent: 2 of 4 resumes hung. It is the same mechanism as run 1's configd hang.
- **To change:** retro item 35 (Maintainer decision 2026-10-26, option A) denies every unlisted Mach lookup with `(with no-report)` before the allow list. Permissions do not change. The cost is that denied lookups no longer appear in the sandbox deny log.
- **Re-run:** see run 3 below.

## Run 3: 2026-10-26 at about 17:35Z, `main` 61e2264 (item 35 merged as #209; tagged `runner-13` at 8169989, with no `src/` or `test/` change between them)

Epic 3 retro item 2 asks for this re-run. The host's sandbox suite had already been run at item 35's PR head 8bedee7: `bun test test/sandbox/` gave 336 pass, 3 skip, 0 fail, and the new case `mach lookups > a lookup of an unlisted service fails at once instead of hanging; a listed one still succeeds` passed in 28 ms.

| Command | Result | Time |
|---|---|---|
| `XARABOT_LIVE=1 bun test test/adapters/agent/codex/codex-live.test.ts` | 5 pass, 0 skip, 0 fail | 53 s |

- **The cases that failed before:**
  - `codex live > resume: a run that wrote no result is resumed with codex exec … resume <thread_id> and writes it` passed in 14.3 s. In run 2 it hung for 244.9 s.
  - `codex live > outcome mapping: …` passed in 12.3 s.
  - Neither case prints more than its pass line. The test does not print the resumed run's model, so that is unverified here.
- **What it printed:**
  - **Subagent tokens:** the parent's `turn.completed` is input 4768, output 108, cacheRead 66944, and two children were counted (2003/5/12032 and 211/5/…).
  - `credentialRewritten: false`.
  - **Proxy hosts:** `allow ab.chatgpt.com:443`, `allow chatgpt.com:443`, and `deny` for the four `sdmntpr*.oaiusercontent.com:443` hosts.

## Story 3.1's host list (retro finding A3)

- **The spike's unresolved address:** `2606:4700:440b::ac40:9034` (spike note, question 8) is one of the two AAAA records of all four `sdmntpr{central,northcentral,southcentral,westcentral}us.oaiusercontent.com` hosts. The other is `2a06:98c1:310d::6812:2bcc`, looked up on 2026-10-26. The proxy denies those four hosts in every run, so they are the connection the spike saw.
- **Maintainer decision (2026-10-26):** the four hosts stay denied. With them denied, codex passes the cross-vendor suite (76/76), the codex contract (11/11) and the codex live checks (5/5).
- **The final list:** for a ChatGPT login it is `chatgpt.com`, `ab.chatgpt.com` and `auth.openai.com`, plus `api.openai.com` in API-key mode. `files.openai.com` stays out: no run reached it.
- **Still open:** the comment in `src/adapters/agent/codex/codex-agent.ts`, which says the list waits for this run, is corrected by Epic 3 retro item 12.

## Open follow-ups

- A session that blocks with no output waits out `SESSION_MS` (3 h), and the harness stopped first at 40 min. A no-output watchdog is a separate design decision (Epic 3 retro item 7), not yet routed.
- The switch after Epic 3 (`self-host.md` § "The switch after Epic 3") also waits for Epic 3 retro item 1 (finding C1) to merge in a runner tag.
