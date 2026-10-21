# Reconcile: spec review findings vs Architecture Spine

- **Spine:** `../ARCHITECTURE-SPINE.md` (draft, updated 2026-10-21), rationale in `../.memlog.md`
- **Input:** `_bmad-output/planning-artifacts/reviews/spec-xarabot-review-2026-10-20.json` (92 findings)
- **Spec checked:** `_bmad-output/specs/spec-xarabot/SPEC.md` and companions, as of this branch
- **Scope:** the 23 adversarial and 48 edge-case-hunter findings (F1–F71). The 21 structure findings (F72–F92) are skipped as instructed.
- **Numbering:** `F<n>` is the finding's 1-based position in the JSON array.

## Classes

| Class | Meaning | Count |
| --- | --- | --- |
| covered | A spine AD settles it | 44 |
| resolved-by-spec | SPEC.md or a companion now settles it | 8 |
| deferred-explicitly | A spine Deferred bullet names it | 6 |
| GAP | Neither the spine nor the spec settles it, or what they say contradicts itself | 13 |
| **Total** | | **71** |

The GAP list also includes 5 issues inside the spine that no single finding raised (X1–X5). They are not counted in the table above.

## Classification

| # | Lens | Finding (short) | Class | Where it is settled, or what is missing |
| --- | --- | --- | --- | --- |
| F1 | adv | 0.x agents inherit the host's `gh` login if the sandbox ships late | **GAP** | Spec puts the CAP-18 sandbox in 0.x, and AD-17 refuses a session with no sandbox. But the spec says the bootstrap Epic is only "`next`, plumbing, STOP and history". Nothing orders the sandbox before the first unsandboxed `claude -p` on the Xarabot host, which has a human `gh` login, an SSH key and an osxkeychain helper (memlog). This applies to both the bootstrap copy and Xarabot's first self-hosted runs. |
| F2 | adv | Which PRs need the owner's approval | resolved-by-spec | CAP-13: no Protected Path means checks plus the CAP-8 review; a Protected Path needs the owner's approval. AD-7 adds parked-held. |
| F3 | adv | Story status lifecycle; who marks a Story done | covered | AD-3 (coordinator marks done), AD-4 (merged tombstone, ledger wins), AD-10 (builders never write status files). See X3 for the clash between the manifest and the Story file. |
| F4 | adv | Coordinator is not a singleton across machines | covered | AD-8 |
| F5 | adv | Heartbeat interval; fencing before push and merge | covered | AD-6. See X1 for the time-of-check gap in the fence. |
| F6 | adv | Takeover of an expired claim | covered | AD-9 |
| F7 | adv | Blocked state has no home; release or hold per block kind | covered | AD-4 (parked record), AD-7 |
| F8 | adv | Story manifest undefined | covered | AD-10 |
| F9 | adv | Dependency graph assumes `package.json` | covered | AD-11; CAP-2 text also settles it |
| F10 | adv | "Next Epic" is ambiguous on a DAG; in-flight Epics at a checkpoint | covered | AD-12 |
| F11 | adv | Reviewer for pi; cap value; vendor identity per adapter and model | **GAP** (partial) | AD-16 settles the reviewer table and cap = 2. Vendor identity is taken from the adapter, not the model. A `pi` lane on an OpenRouter `anthropic/*` model gets a Claude reviewer, which is the same vendor. Also, AD-16's "checked when the lane starts" never says what a failed check does: refuse to start, or park later. |
| F12 | adv | Bootstrap acts as edanisko with admin merges | resolved-by-spec | SPEC Process: bootstrap runs as `edanisko-xarabot`, with no admin merges |
| F13 | adv | Self-hosted runner pinned or run from `main` | resolved-by-spec | SPEC "Pinned runner"; AD-25 |
| F14 | adv | Cutover sequence and rollback | resolved-by-spec | SPEC Non-goals: Xaravel's course correction plans and runs adoption. `brownfield-xaravel.md` § Adoption. |
| F15 | adv | Runner runs verify and install commands with the token | covered | AD-18; AD-20 (config only from `main`) |
| F16 | adv | No hard stop; graceful stop can take hours | covered | AD-22 (`stop --now`), AD-2 (`wake`) |
| F17 | adv | Standing Authority: recheck timing, "invalid", fetch failure | **GAP** (partial) | AD-20 settles the recheck points and failing closed on a fetch failure. It never says what makes the file valid. AD-20 says all config is versioned YAML, but Xaravel's Standing Authority file is `decisions/MAINT-…md`, a Markdown file. No format, required fields or validity rule exists. |
| F18 | adv | Who commits; co-author trailers | covered | AD-15 |
| F19 | adv | Per-owner inbox and channel | covered | AD-23; CAP-9 |
| F20 | adv | 1.4 Stories/hour metric undefined | resolved-by-spec | SPEC Success signal (7-day window, exclusions) |
| F21 | adv | Detecting a Human Live Step | deferred-explicitly | Deferred "Detecting Human Live Steps (v1)"; AD-14 `blocked.kind: human-live-step` + `step_id` |
| F22 | adv | CAP-1 list of consumer-supplied artifacts | resolved-by-spec | CAP-1 intent now lists them |
| F23 | adv | Model floor hard-coded | resolved-by-spec | SPEC Models: "Xarabot enforces no model floor" |
| F24 | ech | Lane alive but heartbeats stop for over 30 minutes | covered | AD-6 (see X1) |
| F25 | ech | Usage-limit sleep outlasts the claim expiry | covered | AD-6, AD-22 (heartbeat continues, claim kept) |
| F26 | ech | Usage-limit reset time missing or far away | covered | AD-22 |
| F27 | ech | Release or hold rule per outcome | covered | AD-7 table (see F52 for the attempts row) |
| F28 | ech | Clock skew across hosts | covered | AD-5 (forge `Date` header) |
| F29 | ech | Force-push or deletion of `xarabot/claims` | covered | AD-4 Protection (ruleset as a Human Live Step); `force: false` compare-and-swap |
| F30 | ech | Heartbeat swap rejected as non-fast-forward | covered | AD-4 (re-fetch, re-apply, jittered retry) |
| F31 | ech | Manifest globs missing or empty | covered | AD-10 |
| F32 | ech | Wildcard glob overlap | covered | AD-10 (conservative literal-prefix rule) |
| F33 | ech | Story merged before the coordinator marks it done | **GAP** (partial) | AD-4 tombstone settles the case where a live lane sees its own merge. Two cases are open. (a) A parked-held PR that the owner approves and merges: the parking process has exited (AD-2), yet AD-3 names "the runner that holds or parks" as the tombstone's only writer, so nobody writes it. (b) A runner that dies between the merge and the tombstone write. AD-7 also never says who enqueues a parked-held PR after approval, or whether approval counts as the "ruling" that clears `parked`. |
| F34 | ech | Unit already has an open or merged PR | **GAP** (partial) | AD-9 adopts the existing branch or PR only on "takeover of an expired claim". After a failed attempt the record is removed (AD-7), so the next claim is fresh, not a takeover, and the rule is silent. The branch and PR still exist. AD-13 does not list PR state as an input to `next` for builders. |
| F35 | ech | Builder takes a coordinator unit | covered | AD-13 (`next(snapshot, laneRole)`) |
| F36 | ech | No eligible unit | covered | AD-13 (`idle` with reason), AD-2 (30-minute idle wait) |
| F37 | ech | Graph cycle or dangling reference | covered | AD-11 |
| F38 | ech | Epic numbered after a checkpoint that does not depend on it | covered | AD-12 (deliberately not held; Maintainer decision in memlog) |
| F39 | ech | Checkpoint go is not an input to `next` | **GAP** (partial) | AD-12 and AD-3 record the go in `retro-gates.yaml`, written by the coordinator. Nothing says how a ruling or go reaches the coordinator: issue comment, checkbox or file. Nothing says how its author is checked. AD-3 also names no writer that clears a `parked` record on a ruling. |
| F40 | ech | "Next" and "after next" on a DAG | covered | AD-12 (distance along `Depends on`) |
| F41 | ech | Retro items tagged `waiting` or `deferred` | **GAP** | AD-12 defines only `blocking` and "untagged open". The memlog's `retro-gates.yaml` schema has an item `status`, but no rule says which statuses count as open. `waiting` items are Maintainer items in CAP-9, and their gate effect is undefined. |
| F42 | ech | Each machine runs its own coordinator | covered | AD-8 |
| F43 | ech | No coordinator runs while builders do | **GAP** (partial) | AD-8: builders continue and "the Maintainer's inbox gets an item". But AD-23 makes the coordinator the only inbox writer, so with the coordinator dead nobody writes it. No rule covers a coordinator that never started (no `coordinator.json` to expire). |
| F44 | ech | A Story's globs cover the status YAML files | **GAP** | AD-10 states the rule (builders never change manifests, `epics.md` or the status YAML files). The only enforcement is the v1 diff check, which is Deferred. In 0.x, CAP-4's success test ("no write to `sprint-status.yaml` or `retro-gates.yaml` from a builder") has no enforcement point. The runner would squash and push such a diff. |
| F45 | ech | launchd relaunches a lane that stopped | covered | AD-22 (STOP checked at process start) |
| F46 | ech | STOP during a pipelined claim or a usage-limit sleep | covered | AD-22 (graceful stop finishes the unit; `stop --now` and `wake`); pipelining is Deferred |
| F47 | ech | Cannot fetch `main` to check Standing Authority | covered | AD-20 (fail closed) |
| F48 | ech | Authority revoked while a unit is in CI or the queue | covered | AD-20 (recheck before push, enqueue, merge) |
| F49 | ech | Lane PR edits authority or policy files | covered | AD-20 (`.xarabot/**` and the Standing Authority file are Protected Paths, read only from `main`); Actor registry Deferred |
| F50 | ech | Adapter policy missing or unparsable | covered | AD-20 (fail closed), AD-21 (start checks) |
| F51 | ech | pi model at OpenRouter sign-in differs from config | **GAP** | AD-21 lets an unset `model` fall back to the adapter default, which for pi is "the model picked at OpenRouter sign-in". Nothing compares the model the CLI reports (AD-14 parses it) with the configured or allowed model. |
| F52 | ech | Invalid output or crash: retry cap and release | **GAP** (partial) | AD-7 says "record removed … `attempts` + 1 is kept, and at 3 the unit parks". AD-5's `state` enum is only `claimed`, `parked` or `merged`, so a removed record cannot keep `attempts`. Two builders of the ledger will pick different encodings, or the cap never trips. |
| F53 | ech | Session hangs | covered | AD-22 (3 h limit; kill after the result file appears), AD-2 |
| F54 | ech | CI never starts or stays pending | covered | AD-22 (CI maximum wait, then park), AD-7. Default value unset (see X5). |
| F55 | ech | Merge queue ejects the PR | covered | AD-19 (merge `main`, poll again, re-enqueue, counts toward `attempts`) |
| F56 | ech | Shared-file conflicts (lockfile, `package.json`) | covered | AD-19 `[ASSUMPTION]` (lockfile regenerated in the sandbox; anything else goes to a builder session) |
| F57 | ech | Rename, delete, symlink or mode change across globs | deferred-explicitly | Deferred "Guard diff check and CI re-check (v1)" |
| F58 | ech | Unit fate after a diff refusal | covered | AD-7 (guard refusal: parked, globs released) |
| F59 | ech | Runner runs install or git in the agent's worktree with the token | covered | AD-18 |
| F60 | ech | No reviewer vendor for pi | covered | AD-16 (`pi`→`claude`); see F11 |
| F61 | ech | Reviewer disallowed, out of usage or failing | covered | AD-16 (park blocked; never merge unreviewed). Minor: whether a reviewer usage limit sleeps (AD-22) or counts as "unavailable" (AD-16 park) is unstated. |
| F62 | ech | Pipelined dependent after its parent PR fails | deferred-explicitly | Deferred "Pipelining (after v1)" |
| F63 | ech | Killed lane resumes wip after its claim expired | covered | AD-9 Restart |
| F64 | ech | Lessons from fetched `origin/main` | deferred-explicitly | Deferred "How Lessons get injected (v1)" |
| F65 | ech | Gate code changes between check and merge | deferred-explicitly | Deferred "Guard diff check and CI re-check (v1)" (merge-group re-check) |
| F66 | ech | Escalation text normalization | deferred-explicitly | Deferred "Xarabot-owned Escalations (v1)" |
| F67 | ech | Hosts on different versions share one ledger | **GAP** (partial) | AD-5 has a reader refuse unknown or newer `schema_version`, but "refuse" is undefined. If a lane skips the unreadable record, it cannot see that record's globs, and may claim an overlapping unit or the same one. |
| F68 | ech | Old loop and lanes run together during handoff | resolved-by-spec | SPEC: Xaravel paused, old loop stopped; adoption is a non-goal run in Xaravel |
| F69 | ech | Bot token expired, revoked or rate-limited mid-unit | **GAP** | AD-26 mints tokens on demand, but no AD sorts forge failures into classes (transient, rate-limited, auth or permission, not installed). No AD says what the lane does for each class: re-mint, back off past the reset, stop, inbox. A heartbeat that fails during a secondary rate limit can let the claim expire. |
| F70 | ech | More builders than `XARABOT_MAX_BUILDERS` | covered | AD-21 |
| F71 | ech | PID reused after a crash or reboot | covered | AD-22 (start time and command checked), AD-2 (`wake` checks it is still that `sleep`) |

## GAPs, with suggested fixes

Ordered by risk: safety holes first, then points where two Epics would diverge.

| GAP | Risk | Suggested fix |
| --- | --- | --- |
| F1 Sandbox order vs the bootstrap and first self-hosted runs | Safety | Ask the Maintainer. Either put the AD-17 sandbox in the first Epic, before self-host, or require the bootstrap lane to run under a dedicated OS user on the Xarabot host with no `gh` login, SSH key, keychain helper or `GH_TOKEN`. Record the chosen interim rule in the spine. |
| F44 No 0.x enforcement of coordinator-only and Protected files | Safety (CAP-4 is a 0.x success test) | Add a 0.x pure core check before the squash: refuse any builder diff touching `sprint-status.yaml`, `retro-gates.yaml`, `epics.md`, the manifest directory, `.xarabot/**` or the Standing Authority file. It parks as a guard refusal (AD-7). v1 extends this check; it does not replace it. |
| F39 Ruling and go channel, and who may give one | Safety (public inbox issue) | Add an AD for rulings. Give the format, such as a `/xarabot <verb> <unit-id>` comment or checkbox on the owner's inbox issue. Accept a ruling only when its author is the owning human, or the Maintainer for gates. The coordinator applies it and is the writer that clears `parked` (add it to AD-3) and records the go in `retro-gates.yaml`. |
| F67 Meaning of "refuse" for unknown `schema_version` | Safety (overlap) | Fail closed: an unreadable ledger record stops the lane before `next`, adds an urgent inbox item and is never skipped. |
| F33 Tombstone writer for owner-merged parked-held PRs, and for a crash after a merge | Divergence and double build | Make `next`'s snapshot include the PR state for every ledger record that has `pr`. A pure rule turns `parked` + merged PR, or `claimed` + merged PR, into `merged`. Name one writer in AD-3 (the coordinator, or any lane by compare-and-swap). State who enqueues after the owner approves (the coordinator or a builder taking a "parked-approved" unit) and whether approval clears `parked` with no ruling. |
| F52 `attempts` cannot survive "record removed" | Divergence; retry cap never trips | Add a `released` state to AD-5's enum (no globs, no owner, claimable, keeps `attempts` and `pr`). Alternatively keep counters in a separate ledger file. Update AD-7 and the state diagram. |
| F34 Adoption applies only to "takeover" | Divergence and duplicate PRs | Reword AD-9: every claim (fresh, after `released`, or takeover) adopts the unit's branch and open PR if they exist. Add the PR state to `next`'s inputs (as in F33). |
| F43 Inbox writer when the coordinator is dead or absent | Divergence; silent stall | Let any builder that sees a missing or expired `coordinator.json` post one deduplicated urgent comment (the only exception to AD-23's single writer), or let `xarabot status` surface it, and name which. Treat "no `coordinator.json` ever" the same as expired. |
| F69 Forge failure classes | Divergence between the forge-adapter and lane Stories | Add failure kinds to the forge port's error type (`transient`, `rate-limited{reset}`, `auth`, `not-installed`, `conflict`) and test them in the contract suite. Map them in AD-7 or AD-22: re-mint once on 401; back off past the reset on a rate limit (heartbeat first); stop the lane with an urgent inbox item on a persistent 403 or uninstall. |
| F17 Standing Authority file format and validity | Divergence (config Epic vs Xaravel adoption) | Define the Standing Authority schema: a YAML file, or Markdown with YAML frontmatter, with required fields such as `grants`, `owners`, `adapters` and optional `expires`. State the rule that makes it invalid. Point AD-20 and AD-27 at it. |
| F11 / F51 Vendor identity and pi's model | Weakens cross-vendor review (CAP-8) | Derive the reviewer vendor from the model's provider, not the adapter (pi `anthropic/*` gets `codex`). Require `model` for `pi` lanes. Fail the attempt when the model the CLI reports differs from the configured one. State that a failed reviewer-pair check at start refuses the lane. If this goes beyond CAP-8's table, route it to `bmad-spec`. |
| F41 Gate effect of `waiting` and `deferred` retro items | Divergence (retro-gates schema vs gates in `next`) | List the item `status` values in the `retro-gates.yaml` schema, and say in AD-12 which count as "open": for example, `open` and `waiting` gate and `deferred` does not. Each gets a `next` test. |

### Spine-internal issues no single finding raised

| # | Issue | Suggested fix |
| --- | --- | --- |
| X1 | The AD-6 fence only reads. It checks owner and generation but not `heartbeat_at`, so a lane silent for over 30 minutes still passes its own read. A takeover can land between the read and the push. AD-15 squashes on every loopback, which forces a force-push of the unit branch, and the push mode is unstated. | Fence by writing: run a heartbeat compare-and-swap that must succeed with a fresh `heartbeat_at` immediately before each external action. Push unit branches only with `--force-with-lease=<branch>:<expected sha>`. |
| X2 | AD-15 makes one squashed commit, while AD-19 merges `origin/main` into a conflicting PR. AD-16 reviews "the final squashed diff", but CI fixes, conflict merges and queue-ejection fixes change the diff after the review. No AD covers handling a CI failure: who fixes it, whether it is a builder session, whether it counts as an attempt, and the cap (AD-24 only counts `ci_fixes`). | Add one AD for the post-build order: squash, review, push, CI. A CI fix or non-trivial conflict re-squashes and re-runs the review. Set its cap and whether it counts toward `attempts`. Say whether merging `origin/main` re-squashes onto the new base. |
| X3 | AD-3 has the agent write the Story spec `status` inside the PR diff, while AD-10 forbids builders from changing a manifest. Xaravel's `stories/<id>.md` is the manifest and carries `status`. If the BMAD Story file and the manifest are the same file, the two ADs conflict. | Say in AD-10 whether the manifest and the BMAD Story spec file are one file. If they are, exempt the `status` frontmatter key from the "never change a manifest" check. If not, name both paths. |
| X4 | The SPEC allows retro and other sessions "a read-only token or data the runner prefetched". AD-17 bans every GitHub host, so only prefetch remains, and no prefetch contract exists (what, where, in what format). | Add to AD-14 or AD-17: the runner writes the prefetched forge data (PR history, review comments) to `.xarabot/context/` in the clone before a coordinator session. Name the files and their schema. |
| X5 | Unset defaults: CI maximum wait (AD-22), exit-lag grace minutes (AD-22), and back-off bounds for ledger retries (AD-4). | Give each a default in the package config schema (AD-20), so separately built Stories share one value. |
