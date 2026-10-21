---
review_of: ARCHITECTURE-SPINE.md (xarabot, draft, updated 2026-10-21)
lens: good-spine rubric (8 items)
inputs: SPEC.md and companions, .memlog.md, spec-xarabot-review-2026-10-20.json, bootstrap/join.ts
reviewed: 2026-10-21
---

# Rubric review: Xarabot architecture spine

## Verdict

**Revise before Epics are cut. Do not rewrite.** The core is strong. The paradigm, the ledger-by-CAS, fencing, single-writer state, the one-wrapper sandbox, the runner-owned commits and the runner-enforced review are the right decisions, and most of the 2026-10-20 review mechanics are settled. But the spine has 7 high findings that would make parallel Epic lanes diverge:

- The ledger state machine contradicts itself.
- The inbox writer rule contradicts three other ADs.
- Nothing binds a lane to a repository.
- The builder write-ban has no 0.x enforcement.
- The seam between agent adapters and the sandbox is undecided.
- The reviewer output and re-review rule are undefined.
- Several operational dimensions are silent.

Severity counts: critical 0, high 7, medium 15, low 11.

---

## 1. Real divergence points for Epics are fixed, and none are missed

Fixed well: unit ids, ledger record fields, result schema, manifest frontmatter, Epic graph bullets, gate rules, `next` ordering, config layers, branch naming, the error shape and the test style.

Missed or half-fixed:

- **H1-a (high). Port operations and the decision snapshot are not defined.** `src/ports/` names five files (`forge.ts`, `agent.ts`, `sandbox.ts`, `clock.ts`, `lane-store.ts`), but the spine does not list their operations. It also does not define the snapshot that `next(snapshot, laneRole)` and the gates take. These are the seams that the forge, agent ×3, sandbox, lane and `next`/gates Epics meet at. If each Epic grows its own snapshot or adds methods to `forge.ts` in parallel, the Epics conflict. *Fix:* add an AD that lists each port's operations by name (forge: `readLedger`, `casLedger`, `serverNow`, `pushBranch`, `openOrUpdatePr`, `prState`, `checks`, `enqueue`, `merge`, `readInbox`, `writeInbox`, `comment`, `fetchMain`; agent: `capabilities(model)`, `buildInvocation(unit, prompt, settings)`, `parseUsage(output)`; and the others). Name the `Snapshot` schema fields in `src/core/schemas/`. Say that the Epic which lands a port owns that port file, and that other Epics extend it only through that Epic's Stories.
- **H1-b (high). The seam between agent adapters and the sandbox is undecided.** AD-1 says "only adapters touch ... the OS", and the layer table forbids adapters from importing `src/sandbox`. Yet every agent must run inside the sandbox (AD-17). So who spawns the agent process? Three adapter Epics and one sandbox Epic will each answer this differently. *Fix:* the agent adapter returns an invocation value (argv, env allowlist additions, vendor hosts, writable state dir, output parser). `src/sandbox` launches it, and the lane composes the two. Also fix AD-1's wording: `src/lane` and `src/sandbox` also do I/O. The rule should read "nothing under `src/core/` does I/O".
- **H1-c (high). The reviewer's output contract is undefined.** AD-14 defines only the builder result. AD-16 depends on "blocking findings", which have no schema. Nothing says whether merging `origin/main` (AD-19), resolving a conflict in a builder session, or re-enqueueing after ejection requires a re-review. AD-16's own "Prevents" line ("a reviewed diff that differs from the one that merges") is broken by AD-19. *Fix:* add a `review.json` schema (`schema_version`, `unit`, `reviewed_sha`, `findings[{severity, blocking, file, text}]`, `verdict`). Add a rule: any change to the PR diff other than a clean merge of `origin/main` with no conflicts sets `reviewed_sha` stale and requires a new review before enqueue.
- **M1-d (medium). Coordinator work items are missing from the unit ids.** "Open coordinator PR" and "rulings" (AD-13) have no unit id. Writing `done` into `sprint-status.yaml` from tombstones, and the daily digest rewrite (AD-23), are neither unit kinds nor in the coordinator's order. The trigger that creates a `planning:<slug>` unit is not defined either. *Fix:* list every coordinator unit kind with its id, its trigger and whether it runs an agent. Name `status-sync` and `digest` as runner-only kinds.
- **M1-e (medium). Result channel for coordinator sessions.** AD-14 routes "every session" through `bmad-build-auto`'s `on_complete` hook. Retro and planning sessions run `bmad-retrospective`, `bmad-sprint-planning` and `bmad-create-epics-and-stories`, not `bmad-build-auto`. *Fix:* state how those sessions emit `result.json`: a prompt instruction validated by the runner, or a `bmad-customize` hook for each skill.
- **M1-f (medium). Data prefetched for sessions that read GitHub.** SPEC § Constraints allows "a read-only token or data the runner prefetched". AD-17 forbids every GitHub host, so only prefetch remains, and the spine never defines it. Retro sessions need PR history. *Fix:* the runner writes `context/` (PRs, reviews and checks for the Epic) into the session's temp dir in a schema'd form. Add that schema to the AD-27 list.
- **M1-g (medium). Who drives `CHANGELOG.md`.** CAP-1 requires a changelog entry per release. If every Story edits one `CHANGELOG.md`, parallel lanes conflict on every PR. *Fix:* decide fragment files per Story (`changes/<unit-id>.md`, combined at release by the Maintainer's CI), or a changelog written only at release time.
- **M1-h (medium). Unit-branch push semantics after the first push.** AD-15 says the runner squashes into one commit. A loopback after review and AD-19's merge of `origin/main` must then either force-push a re-squash or add commits. *Fix:* state the rule. For example, the first push is one squashed commit, later pushes are fast-forward only, and the PR is squash-merged by the queue anyway. Also say that a stale lane's push uses `--force-with-lease=<expected sha>`, which closes the gap between the AD-6 check and the push.
- **L1-i (low). Mapping from story id to unit id.** The rule that maps `story_id` and `sprint_key` from AD-10 to `story:<epic>.<n>`, and to the `story/<id>` branch that AGENTS.md uses, is not stated. *Fix:* unit id = `story:` + `story_id`, and `story_id` must match `<epic>.<n>`.
- **L1-j (low).** The forge adapter's transport is undecided: the `gh` CLI or `fetch` to REST/GraphQL. Shelling out to `gh` picks up the human's login unless the token is injected. *Fix:* the forge adapter uses `fetch` with the installation token, and the runner never calls `gh`.

## 2. Every AD Rule is enforceable and prevents its divergence

- **H2-a (high). AD-7, AD-4 and AD-5 contradict each other on failed attempts.** On a crash the "record is removed ... `attempts` + 1 is kept". But `attempts` lives in the record, and `state` is only `claimed | parked | merged`. AD-13 then lets builders take only Stories "not in the ledger". A retained record would therefore make the unit unclaimable forever, and a removed record loses the count. The state diagram also sends "expired" to `[*]`, while AD-5 and AD-9 describe takeover in place with `generation + 1`. *Fix:* add a state `released` (no owner, `attempts` kept, claimable). Change AD-13 to "no record, or a `released` record". Draw takeover as `claimed → claimed` (new owner, generation + 1).
- **H2-b (high). `parked_held → merged` has no actor.** The lane process exits after the unit (AD-2). Builders skip units that are in the ledger. The coordinator takes only its own PRs. So once the owner approves, nobody enqueues the merge. If the owner merges by hand (CAP-13 success), nobody writes the tombstone. *Fix:* name the actor. For example, the coordinator's `rulings`/`status-sync` work polls `parked`+held PRs, enqueues the approved ones under fencing as the PR's bot, and writes `merged`. Or say that a manual merge is detected from forge PR state, which `next` treats as merged.
- **H2-c (high). AD-23's sole inbox writer contradicts AD-7, AD-8, AD-11 and AD-20.** AD-7 has builders produce an "inbox item". AD-8 posts an item when the coordinator's own claim expires, at a moment when no coordinator is alive to write it. AD-11 and AD-20 stop every lane, the coordinator included, on a bad graph or missing authority, so the CAP-9 "notifies at once" item can never be sent. The ruling mechanism is also undefined: what is a ruling, where is it written, and who clears `parked` in the ledger? AD-3 gives the parked record only one writer. *Fix:* inbox items are derived from the ledger (`parked` + `inbox_owner`) plus forge state, and only the coordinator renders the digest. Any lane may post the single urgent @mention comment, deduplicated by a marker on the issue. A fail-closed stop still allows that one notice. Define a ruling as a structured comment or checkbox that the coordinator parses, after which it clears `parked`. Add the coordinator to AD-3's writers for parked and tombstone records.
- **M2-d (medium). AD-3's "one writer" is untrue for the ledger row.** The holder, a takeover lane, the coordinator (tombstones, rulings) and the parker all write it. *Fix:* split the row by transition, and say that CAS plus fencing makes the multiple writers safe.
- **M2-e (medium). AD-20 "invalid Standing Authority" cannot be tested.** No validity rule exists, and AD-27's schema list omits it. Xaravel's file is a markdown MAINT decision. *Fix:* define validity, for example "exists on `origin/main` and has frontmatter `grants: [lanes]` and `expires`", or "exists and is non-empty". Add it to AD-27.
- **M2-f (medium). The fail-closed "stop" has no process-level meaning.** "Stops the lane" (AD-20) and "stops every lane" (AD-11) are undefined under launchd KeepAlive or systemd `Restart=`. A process that exits non-zero is restarted in a tight loop. *Fix:* "stop" means take no claim, write `outcome: stopped:<reason>`, then do the idle wait (30 min) and exit 0. Or it means writing the lane `STOP` marker. Choose one.
- **M2-g (medium). Missing numbers.** These have no values: the CI maximum wait (AD-7, AD-22), "a set number of minutes" after the result file (AD-22, where the brownfield lesson gives about 12 minutes), the CI poll interval (AD-19) and the ledger CAS retry bound (AD-4). *Fix:* give each one a config key and a default in the AD.
- **M2-h (medium). Protected Paths are needed in 0.x but never located.** AD-7 parks a PR "waiting for its owner's approval" only when it touches a Protected Path. The spine does not say where the runner reads the Protected Path list (repo `policy.yaml`? CODEOWNERS? Xaravel's `conformance/protected-paths`?) or how it detects "awaiting approval" (PR `reviewDecision`). *Fix:* add `protected_paths` to the `policy.yaml` schema. Detect waiting from the forge's review decision.
- **L2-i (low). AD-1 and the layer table have no enforcement.** *Fix:* name the mechanism. Use oxlint `no-restricted-imports` per directory and `no-restricted-globals` for `Date`, `fetch`, `process` and `Bun` in `src/core/`, or an import-graph test.
- **L2-j (low). AD-12 "Epics already in flight when C closes" is unreachable as worded.** The start rule already blocks dependents of C until C's retro is done. *Fix:* define "closes", or drop the clause.
- **L2-k (low). AD-10 "literal prefix" overlap.** It does not say whether prefixes are compared by character or by path segment. *Fix:* compare by path segment, before the first glob metacharacter. Two globs overlap if one prefix is an ancestor of, or equal to, the other.

## 3. Nothing under Deferred lets two units diverge now

- **H3-a (high). Deferring the guard diff check leaves 0.x write-bans without enforcement.** AD-10 and AD-3 forbid builders to change manifests, `epics.md`, `sprint-status.yaml` and `retro-gates.yaml`, and CAP-4's 0.x success test checks exactly that. With the diff check deferred to v1, only the agent's own obedience enforces it. In Xaravel the manifest `stories/<id>.md` is also the BMAD story file whose `status` the agent writes (AD-3, row "Story spec status"). So a well-behaved build session itself edits the file AD-10 bans. *Fix:* in 0.x, a pure check in core refuses a builder diff that touches a fixed list: the coordinator-owned files, `.xarabot/**`, the Standing Authority file and the manifest directory. The `status:` frontmatter key is the one exception. Or require the manifest and the BMAD story spec to be separate files. Keep the full guard in v1.
- **M3-b (medium). Local-only adapter.** It is deferred, but the forge port is being shaped now by GitHub-only concepts: PR numbers, the merge queue, the `Date` header and pinned issues. *Fix:* when the port operations are listed (H1-a), state each operation's local-only meaning, so the GitHub adapter does not leak GitHub concepts into the port.
- **L3-c (low). Escalations in 0.x are "read through config", but the config key and the detection rule are not defined.** *Fix:* add `escalations: {path, open_when}` to the config schema.

The other deferrals (spec-folder shape, Lessons, Actor registry, Human Live Step detection, pipelining, cross-host telemetry, Linux packaging) are safe as written.

## 4. Named technology is current (shallow check; deep version check is another reviewer's job)

- **M4-a (medium).** Bubblewrap 0.13.1 is not verified. The memlog says "srt and bwrap not installed", and no `(version)` entry covers bwrap. Also verify that the pin of codex-cli 0.163.0 matches the host, which has 0.162.1.
- **L4-b (low).** Apple has deprecated `sandbox-exec`, though it still works on macOS 27.0.1 (memlog). Record that risk as an open item.
- **L4-c (low).** Confirm that the TypeScript 7.0.2 compiler binary is `tsc` and not `tsgo`. The conventions row says `tsc --strict`.
- **L4-d (low).** AD-27 marks zod as `[ASSUMPTION]`, while the Stack table pins 4.6.7 as decided. Confirm it or move it to open items. The same applies to AD-19's `[ASSUMPTION]` on other conflicts.
- **L4-e (low).** AD-17 assumes that `claude`, `codex` and `pi` all honor `HTTPS_PROXY` and `HTTP_PROXY` inside the sandbox. Verify this for each CLI in the sandbox Story's contract suite.

## 5. Ratifies, not contradicts, `bootstrap/join.ts`

- **M5-a (medium). Key path.** `join.ts` resolves `$XDG_CONFIG_HOME/xarabot/apps/<name>/`, and only falls back to `~/.config`. AD-26, AD-17's unreadable list and the host layout hard-code `~/.config/xarabot`. With `XDG_CONFIG_HOME` set, the sandbox would not hide the key. *Fix:* write `${XDG_CONFIG_HOME:-~/.config}/xarabot` in AD-26, AD-17 and the layout.
- **M5-b (medium). `app.json` is not ratified.** `join.ts` writes `app.json` (`id`, `slug`, `owner`, `html_url`) next to the key. The runner needs the App ID for the JWT `iss`. Without this, the `xarabot join` Epic and the token Epic can put the App ID in different places. *Fix:* add `app.json` to AD-26 and the host layout as the runner's source of the App ID and slug.
- **M5-c (medium). App permissions differ from the manifest.** AD-23's `issues: write` and the open merge-queue permission cannot reach the existing `edanisko-xarabot` through a manifest. A manifest applies only when an App is created, and `join.ts` skips creation on re-run. There is also no `workflows: write`, so any PR touching `.github/workflows/` fails to push. *Fix:* make "update the App's permissions and accept them on each installation" a Human Live Step. Decide `workflows` explicitly: grant it, or make workflow edits Human Live Steps.
- **L5-d (low).** Ratify `join.ts`'s commit identity, `<slug>[bot] <id+slug[bot]@users.noreply.github.com>`, as AD-15's author format.
- **L5-e (low).** `join.ts` reads `/installation/repositories` without pagination (30 per page by default). An all-repositories install on an org with more than 30 repos falsely fails the reach check. Note it for the `xarabot join` Story.

## 6. Covers CAP-1..CAP-24

All 24 are mapped. Gaps in coverage:

- **CAP-1:** who opens the upgrade PR that bumps the pin (Renovate? a coordinator unit?) and the changelog mechanism (M1-g).
- **CAP-6:** the "progress line" (Stories done, loose ETA) is not placed. *Fix:* make it a field of `status --json`.
- **CAP-8:** see H1-c.
- **CAP-9:** see H2-c. Also, GitHub allows only 3 pinned issues per repo, so "one pinned issue per owner" breaks with a fourth owner (v1). *Fix:* use a labelled issue per owner, and pin only the Maintainer's.
- **CAP-11:** the "feeds the consuming repo's dashboard" export format of `xarabot report` is not decided. There is also no rule for how a run is labelled a subscription run.
- **CAP-13:** the PR-awaiting-approval detection (M2-h).
- **CAP-14:** the setup docs are not placed. Note them as v1 work.
- **CAP-20:** see L3-c.
- **CAP-22:** see M2-e.
- **Wording drift from SPEC:** SPEC says "worktree" (CAP-4, CAP-18). AD-17 decides on a full clone, never a linked worktree. This is a sound refinement, but the spine's own rule says a disagreement goes to the Maintainer. Route it through `bmad-spec` with the codex model-name fix.

## 7. Every dimension the altitude owns is decided, deferred or an open question

Deployment is decided: one host per operator, launchd/systemd, ssh TUI. The rest of the operational envelope is partly silent.

- **H7-a (high). There is no repo dimension on the host.** AD-21's lane fields (`role`, `owner`, `agent`, `model`, `effort`) never name the repository the lane builds. The host layout `~/.xarabot/lanes/<lane>/` and "lane names unique per host" give two consumers on one host (Xarabot self-hosting and Xaravel, both "on the Xarabot host") colliding `builder-1` folders. They also leave per-repo runner pins and the scope of `XARABOT_MAX_BUILDERS` undefined. *Fix:* add `repo` (forge URL) to each lane in `host.yaml`. Key state as `~/.xarabot/repos/<owner>__<name>/lanes/<lane>/`. Say that `XARABOT_MAX_BUILDERS` counts across repos, and that each lane runs the runner version pinned by its own repo's `origin/main`.
- **H7-b (high). Operations are silent or thin.**
  - **Upgrades.** AD-25 does not say how `~/.xarabot/runner/<version>/` gets installed (`bun install` of `@xaravel/xarabot@<v>` into that directory?), which file the lane reads its pin from, or how self-host runs before any npm release exists (a git tag?). It also does not say how a host on an older version treats a newer `schema_version` record (AD-5 says "refuses", but does the lane stop or treat the record as held?).
  - **Recovery.** Nothing covers an unparseable ledger file, a host lost mid-unit, or a launchd crash loop (M2-f).
  - **Observability.** There is no retention or rotation for `logs/` and `journal.jsonl`, and no alert on a lane that keeps failing before it claims.
  - **Secrets.** There is no decision on vendor credentials (Claude login, OpenAI key, OpenRouter via pi): where they live, and how they enter the sandbox's env allowlist or state dir. App key rotation and revocation are not covered.
  - **Backups.** The journals are the only source of the 0.x success metric (1.4 Stories per hour), and they live on one host with no backup decision.

  *Fix:* add an "Operations" AD that settles each line, or move each line to Deferred or open items with a revisit trigger.
- **M7-c (medium). Provider limits.** There is no GitHub API budget: heartbeat CAS every 5 minutes per lane (each one several Git Data calls), CI polling, ledger retries, and multiple hosts sharing one installation's rate limit. There is also no rule for 403/429 secondary-rate-limit back-off. *Fix:* set the poll interval and the back-off in the forge adapter, and add a budget line.
- **M7-d (medium). Every ledger heartbeat is a push to the consumer repo.** That is about 12 commits per hour per lane on `xarabot/claims`, made with an App token, so it triggers `on: push` workflows on every write. *Fix:* ledger commit messages carry `[skip ci]`. Also make "exclude `xarabot/claims` from push workflows" a Human Live Step, and decide on compaction of the branch's history.
- **M7-e (medium). Xarabot's own build and test environment.** The spine does not name the required CI checks (`bun test`, `oxlint`, `tsc`) whose names the merge plumbing will poll. It also does not say where the forge contract suite runs: an in-memory fake forge, or a gated live suite against a scratch repo. *Fix:* decide both. Leave the `.github/` content to the Maintainer.
- **L7-f (low). Host power.** A macOS host that sleeps stops heartbeats and expires claims. *Fix:* host prerequisite (`pmset` / `caffeinate -i` for the duration of a unit), or record it as a known limitation.
- **L7-g (low). The bootstrap slice.** The spine does not say which ADs the bootstrap Epic, built by Xaravel's copied loop, must satisfy and which it may stub (for example, the ledger with a single lane). *Fix:* a short "bootstrap slice" note: ports land first, and the single lane still claims through the ledger.

## 8. Mermaid validity, no placeholders, decisions not rationale, terse

- **Layer graph:** valid, and it matches the table (the edges from cli to the inner layers are transitive, which is fine).
- **Deployment graph:** valid; the edge to the subgraph id `host` is supported. **L8-a (low).** `&lt;lane&gt;` relies on HTML-label decoding. For portability, use Mermaid's entity codes `#lt;lane#gt;`, or drop the angle brackets.
- **State diagram:** valid syntax, but it encodes the contradictions in H2-a and H2-b: "expired" goes to `[*]` instead of a takeover, there is no `released` state for retained attempts, and `parked_held → merged` has no actor. Redraw it after the fix.
- **Placeholders:** none. Template paths such as `<lane>` and `<version>` are fine. Two `[ASSUMPTION]` tags remain (AD-19, AD-27); resolve them or list them under open items.
- **Altitude:** the frontmatter says `altitude: feature`, but the run is spec → epics (memlog: "product spec -> epics"). **L8-b (low).** Correct the frontmatter.
- **Rationale and terseness:** mostly decisions. AD-4 "Not used ... because rulesets cannot protect it" is rationale that belongs in `.memlog.md`. Overall the spine is terse.
- **L8-c (low).** AD-14 writes `.xarabot/result.json` inside the consumer's `.xarabot/`, which is the repo config directory and a Protected Path (AD-20). A v1 guard that denies `.xarabot/**` would block the result file. *Fix:* write the result to the session temp dir (`$XARABOT_RESULT`), which AD-17 makes writable.

---

## Fix order

1. H2-a and H2-b: the ledger state machine (`released` state, takeover in place, the actor for `parked_held`). Redraw the diagram.
2. H2-c: inbox derivation, the urgent notice from any lane, the ruling format, and the AD-3 writers.
3. H7-a: repo binding in `host.yaml` and the host layout.
4. H3-a: a minimal 0.x diff check in core, plus separating the manifest from story status.
5. H1-a and H1-b: port operation lists, the `Snapshot` schema, and invocation handed off to the sandbox.
6. H1-c: the `review.json` schema and the re-review rule.
7. H7-b, M7-c and M7-d: an Operations AD (upgrades, recovery, secrets, backups, rate budget, `[skip ci]`).
8. M5-a, M5-b and M5-c: ratify the XDG path and `app.json`, and the App permission update as a Human Live Step.
