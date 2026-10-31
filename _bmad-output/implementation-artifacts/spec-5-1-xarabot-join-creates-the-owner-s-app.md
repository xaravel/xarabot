---
title: "Story 5.1: `xarabot join` creates the owner's App"
type: 'feature'
baseline_revision: 'affd41f78b5ce4b6dde45945227c191c59fdec17'
created: '2026-10-31'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A human gets their `<login>-xarabot` App only from `bootstrap/join.ts`, a script outside the package with its own JWT code and a manifest missing `issues: write`. A re-run never checks that an existing App still has exactly the permissions Xarabot uses (FR13, NFR9, AR27).

**Approach:** Add `xarabot join --repo <owner>/<name> [--login <login>] [--port <n>]` to the package. With no App record, it serves a pure-built manifest on `127.0.0.1`, opens GitHub's manifest page, checks the callback's `state`, converts the code through the GitHub adapter and stores the key and `app.json`. With a record, it skips creation, reads the App with an App JWT from Story 1.8's code, and stops naming each permission to add, remove or change. Then remove `bootstrap/join.ts` and point the runbook at `xarabot join`.

## Boundaries & Constraints

**Always:**
- The manifest names `<login>-xarabot`, has `public: true`, a webhook that is not active (`hook_attributes.active: false`), `request_oauth_on_install: false`, and `default_permissions` exactly `contents: write`, `pull_requests: write`, `issues: write`, `checks: read`, `statuses: read`, `actions: read`, `metadata: read`. It has no merge-queue, `administration`, `workflows` or bypass permission. The builder is pure, in `src/core/join/`.
- The App folder is `appDir()` from `credentials.ts` (`$XDG_CONFIG_HOME`, else `$HOME/.config`). The folder is mode 700 (chmod it even when it already exists). `private-key.pem` is mode 600 and is written before `app.json`. `app.json` holds only `{ id, slug, owner }`. The conversion's `client_secret`, `webhook_secret` and `client_id` are never written or printed.
- The key text never appears in stdout, stderr, an error message or `app.json`.
- An App record is present when `app.json` exists. A re-run loads it with `loadAppCredentials`, mints the JWT with `createAppJwt` and reads `GET /app`. There is no second JWT or key-loading copy.
- Every GitHub call goes through `request()` in `http.ts`, with new `GITHUB_OPERATIONS` entries: `convertManifest` (`POST`, `none`; no `Authorization` header is sent) and `getApp` (`GET`, `app-jwt`). The CLI never calls `fetch` itself.
- The callback wait has a deadline (15 min by default, injectable) and ends early on SIGINT. No `timeout` binary is called.
- The login comes from `--login`, else from `gh api user --jq .login` (as the bootstrap did, injectable). If that fails, the error tells the user to pass `--login`.

**Never:**
- No installation, install page, install request, reach check, bot-identity printing or installation-token minting: that is Story 5.2. Printing the install URL as a next step is fine.
- No change to the permission-table work of Story 5.1a (one request function audit, table-vs-manifest test), to `APP_PERMISSIONS`' shape, or to `docs/maintainer/app-permissions.md`.
- No change to `.github/`, the spec, the Epic context files, `bootstrap/loop/**`, `AGENTS.md`.
- No token-shaped or PEM literal in any file: tests build keys at runtime with `generateKeyPairSync`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create | no `app.json`; callback with matching `state` and a valid code | conversion called with no token; folder 700, key 600, `app.json` `{id,slug,owner}`; prints slug, App ID, key path and install URL; exit 0 | none |
| State mismatch | callback `state` differs or `code` is missing | nothing written; 400 to the browser | exit 1, "start again" |
| Conversion fails | GitHub answers non-2xx, or the reply lacks `id`/`slug`/`owner.login`/`pem` | nothing written | exit 1, names the op and status |
| Wrong account | conversion's `owner.login` ≠ `--login` (case-insensitive) | nothing written; prints the App's settings URL to delete it | exit 1 |
| Deadline | no callback before the deadline | server stopped, nothing written | exit 1, names the wait |
| Re-run, exact | `app.json` + key; `GET /app` permissions equal the manifest | no creation, no browser; prints "has the manifest's permissions"; exit 0 | none |
| Re-run, missing | App lacks `issues` | lists `add issues: write` and `https://github.com/settings/apps/<slug>/permissions` and calls it a Human Live Step | exit 1 |
| Re-run, extra | App also has `administration: read` (or `workflows`, any other) | lists `remove administration: read` | exit 1 |
| Re-run, level | App has `checks: write` | lists `change checks: write to checks: read` | exit 1 |
| Bad record | key missing, wrong mode or `app.json` invalid | no creation | exit 1 with `loadAppCredentials`' message |
| Bad args | no `--repo`, a malformed `owner/name`, unknown flag | usage | exit 1 |

</intent-contract>

## Code Map

- `bootstrap/join.ts` -- the flow being absorbed: form page with `state`, `/callback`, conversion, key/`app.json` writes. Delete it.
- `src/adapters/forge/github/http.ts:51` -- `GITHUB_OPERATIONS`; add `convertManifest` and `getApp`. `request()` sends no `Authorization` when `token: null`. `APP_PERMISSIONS` (line 108) is the adapter's string list; leave it, and test that it equals the core manifest's set.
- `src/adapters/forge/github/tokens.ts:28` -- `createAppJwt(appId, key, nowMs)`: reuse it.
- `src/adapters/forge/github/credentials.ts` -- `appDir`, `KEY_FILE`, `APP_FILE`, `loadAppCredentials` (checks mode 600, parses the key and `AppRecordSchema`).
- `src/adapters/forge/github/bot-user.ts` -- the shape for a small adapter call: `request` → `isSuccess` → `mapHttpError` → field checks → `ForgeResult`.
- `src/core/schemas/github-app.ts` -- `AppRecordSchema` `{id, slug}` already allows extra keys; leave it.
- `src/cli/main.ts` -- dispatch; add `join` and its usage.
- `src/cli/lane-commands.ts:17` -- the CLI deps pattern (`env`, `out`, `errOut`, injectable effects; returns the exit code).
- `test/adapters/forge/github/fake-github.ts` -- the in-process GitHub. JWT routes are `/app/*` (line 891, so `GET /app` lands in `handleJwt`). Unauthenticated `/users/` is the model for an unauthenticated `POST /app-manifests/<code>/conversions`.
- `test/adapters/forge/github/http.test.ts:229` -- table tests: new ops must use known permissions and avoid merge/approve/delete names.
- `test/support/sandbox.ts` -- `hostTest`: binding a socket is denied in a session, so only the one real-`Bun.serve` case uses it.
- `docs/maintainer/self-host.md:208` -- §5 The App's permissions: point it at `xarabot join`.

## Tasks & Acceptance

**Execution:**
- `src/core/join/manifest.ts` -- `MANIFEST_PERMISSIONS` (record name → level), `appName(login)`, `buildManifest({ login, redirectUrl })`, and `comparePermissions(actual)` → ordered `add`/`remove`/`change` lines. Pure -- the manifest and the re-run check.
- `src/adapters/forge/github/http.ts` -- add `convertManifest` (`POST`, `none`) and `getApp` (`GET`, `app-jwt`) -- the two new calls.
- `src/adapters/forge/github/app-manifest.ts` -- `convertManifest({ code, signal, fetch?, apiUrl? })` → `{ id, slug, owner, htmlUrl, pem }`, and `readAppPermissions({ credentials, now, signal, fetch?, apiUrl? })` → `Record<string,string>` using `createAppJwt`. Validate reply fields; never put the pem in a message -- adapter half.
- `src/cli/join.ts` -- `JOIN_USAGE` and `joinCommand(args, deps)`. Deps: `env`, `out`, `errOut`, `fetch`, `apiUrl`, `now`, `whoami`, `openBrowser`, `serve` (a handler → `{ url, stop }`, defaulting to `Bun.serve` on `127.0.0.1`), `deadlineMs`, `signal`. Write the files and stop as in the matrix -- the command.
- `src/cli/main.ts` -- route `join` and add it to `USAGE`.
- `test/adapters/forge/github/fake-github.ts` -- serve `GET /app` (`id`, `slug`, `owner.login`, `permissions`; options `appOwner` (default `alice`) and `appPermissions` (default the manifest set), plus `setAppPermissions`). Serve `POST /app-manifests/<code>/conversions` with no auth for codes added by `registerManifest(manifest, pem)`; a code is single-use, and the manifest is recorded for tests -- fake GitHub.
- `test/core/join/manifest.test.ts` -- pin the permission set, name, `public`, inactive webhook, no forbidden permission, equality with `APP_PERMISSIONS`, and `comparePermissions` for exact, missing, extra and level cases.
- `test/cli/join.test.ts` -- every matrix row against the fake GitHub with an injected `serve`/`openBrowser` acting as the browser (read the page, take `state` and the manifest, call the callback). Assert modes, the `app.json` keys, no key text in any output, no `Authorization` on the conversion, and no browser on a re-run. Add one `hostTest` with the real `Bun.serve`.
- `bootstrap/join.ts` -- delete.
- `docs/maintainer/self-host.md` -- in §5, say the App is created by `xarabot join --repo xaravel/xarabot --login edanisko` (`bun src/cli/main.ts join …` from a checkout), and that a re-run checks its permissions and names each one to change.

**Acceptance Criteria:**
- Given `xarabot join --repo o/n` with no record, when the browser confirms, then the App is converted and stored as in the matrix, and the key is never printed.
- Given an existing record, when join runs, then no manifest page opens, and any missing, extra or different-level permission stops it, naming each one and the settings URL.
- Given the source, when grepped, then `bootstrap/join.ts` is gone, and no new JWT signer or `fetch` call exists outside `http.ts`.

## Spec Change Log

## Review Triage Log

### 2026-10-31 — Review pass
- verdicts: 33 findings — high 0, medium 10, low 18, false 5, maybe-false 0
- findings:
  - `[medium]` `[patch]` Blind: an App created on GitHub can be lost (write failure, or the deadline/interrupt aborting an in-flight conversion) with a "nothing was written" message that hides that the App exists — patched: the deadline and interrupt no longer end a wait whose callback is being handled, and every failure after a successful conversion names the created App and its delete URL.
  - `[low]` `[reject]` Blind: a re-run deletes a key left without `app.json` — only reachable after a failed `app.json` write, which now tells the user to delete that App; a lost key is also replaceable on the App's settings page; guarding it adds a branch for a rare state.
  - `[medium]` `[patch]` Blind: the converted App's slug is never checked against `<login>-xarabot` (GitHub's page lets the name be edited) — patched: a slug check beside the owner check writes nothing and names the delete URL.
  - `[low]` `[reject]` Blind: the create path ignores the conversion's `permissions` — the manifest page creates the App with the manifest's permissions, and the next re-run checks them; adding a check is extra code for an unseen state.
  - `[low]` `[reject]` Blind: a re-run does not compare the record's slug/owner with `GET /app` — the record and key are read from the login's own folder and only `join` writes them; a hand-copied record is an unlikely state.
  - `[low]` `[reject]` Blind: the PEM is not parsed before writing — GitHub returns a valid key; a bad one surfaces at the next `loadAppCredentials` with a clear message.
  - `[low]` `[reject]` Blind: `gh api user` has no deadline — it runs before any handler is installed, so Ctrl-C ends it; `--login` skips it; a timer and kill add complexity for a rare hang.
  - `[low]` `[reject]` Blind: the re-run's 60 s limit is hard-coded and ignores SIGINT — with no SIGINT handler installed on that path, Ctrl-C ends the process; one GET call needs no injection.
  - `[false]` `[reject]` Blind: `finish` can throw and leave the wait unsettled — `convertManifest` goes through `request()`, which catches every fetch error, and `writeApp` catches its own; no throwing path was shown.
  - `[low]` `[patch]` Blind: the runbook does not say that installing the App is now a manual step — patched in `self-host.md` §5.
  - `[low]` `[patch]` Blind: the runbook implies a re-run checks the installation's accepted permissions — patched: the re-run is described as checking the App's own permissions; accepting on the installation is a separate step.
  - `[medium]` `[patch]` Blind: untested paths (write failure, conversion finishing after the deadline, the default SIGINT wiring, and others) — patched with tests for the write failure, the deadline during an in-flight conversion, the default SIGINT and the real `gh` fallback; the remaining cases (`serve` throwing, a malformed whoami) are cosmetic.
  - `[low]` `[patch]` Blind: the fake repeats the `alice-xarabot` default for `botLogin` and `appSlug`; the source guard greps only `createSign` — patched: `botLogin` is derived from `appSlug`; the guard part is rejected (any second signer would still need `createSign` or WebCrypto, and a review catches it).
  - `[medium]` `[patch]` Edge: a slug other than `appName(login)` is stored — same root cause as the slug-check entry; patched there.
  - `[low]` `[reject]` Edge: a login over 26 characters gives a name over GitHub's 34-character limit — rare; GitHub's page asks for a shorter name, which the new slug check then refuses cleanly.
  - `[medium]` `[patch]` Edge: the conversion succeeded but the abort or a write failure leaves an orphan App with no guidance — same root cause as the first entry; patched there.
  - `[low]` `[reject]` Edge: a 201 reply that lacks fields orphans the App — GitHub's documented reply always carries them; an unseen state.
  - `[low]` `[reject]` Edge: `--login` in a different case gives a differently cased folder — the macOS default filesystem is case-insensitive, and lanes use the same `owner` string the operator typed; rare.
  - `[low]` `[reject]` Edge: `gh api user` hangs — same as the Blind entry; Ctrl-C ends it.
  - `[low]` `[reject]` Edge: a non-RSA key makes `createAppJwt` throw — GitHub App keys are RSA, and the same throw exists in Story 1.8's token path before this change.
  - `[false]` `[reject]` Edge: `bootstrap/loop/token.ts:9` and `README.md:5,56` name the deleted `bootstrap/join.ts` — they say which script wrote the existing key and where to copy it from, which stays true; nothing tells anyone to run the deleted script.
  - `[medium]` `[patch]` Verification gap: no test of a `writeApp` failure — patched: a case with an unwritable config dir asserts exit 1, `cannot write`, the delete URL, no key text and the 500.
  - `[medium]` `[patch]` Verification gap: the default SIGINT wiring is untested — patched with a case that has no injected signal.
  - `[medium]` `[patch]` Verification gap: the real `gh api user` fallback is untested — patched with a `main.test.ts` row with a scrubbed `PATH`.
  - `[medium]` `[patch]` Verification gap (other): a created App is not named when nothing is saved — same root cause as the first entry; patched there.
  - `[low]` `[reject]` Intent: no test reaches the real GitHub manifest page — the Epic asks for CLI tests against a fake GitHub; the live click is Story 5.3's Human Live Step precondition.
  - `[false]` `[reject]` Intent: removing `bootstrap/join.ts` drops its install and reach steps before Story 5.2 — the Story's AC requires the removal when 5.1 is done.
  - `[low]` `[patch]` Intent: the runbook implies the re-run checks the installation's acceptance — same root cause as the Blind runbook entry; patched there.
  - `[low]` `[reject]` Intent: an App that exists on GitHub with no local record starts a create that GitHub refuses — the browser shows GitHub's name error, and the deadline ends the wait; detecting it needs the App's key, which is the thing missing.
  - `[medium]` `[patch]` Intent: the slug is not checked — same root cause as the slug-check entry; patched there.
  - `[false]` `[reject]` Intent: "no webhook" is met with an inactive `hook_attributes` and not an absent one — an inactive webhook delivers nothing, as the bootstrap's manifest did.
  - `[low]` `[reject]` Intent: the wrong-account path leaves an orphan App — it cannot be deleted through the API with what join holds; join writes nothing and prints the delete URL.
  - `[false]` `[reject]` Intent: the test that the manifest's set equals `APP_PERMISSIONS` overlaps Story 5.1a — it is a test only and changes neither the table nor 5.1a's work.

## Design Notes

The injected `serve` keeps the flow testable in a sandboxed session, which cannot bind sockets. The fake browser calls the handler with `new Request("http://127.0.0.1:<port>/callback?code=…&state=…")`. Escape the manifest JSON into the hidden form field (`&`, `"`, `<`, `>`). The manifest page is `https://github.com/settings/apps/new?state=<state>`. The redirect URL uses the server's actual port, so `--port 0` (the default) takes a free port.

## Verification

**Commands:**
- `bun test test/core/join test/cli/join.test.ts test/adapters/forge/github` -- expected: `0 fail`. The real-socket case is skipped in a session.
- `bun test` -- expected: `0 fail`.
- `bun --bun tsc` -- expected: exit 0.
- `bun --bun oxlint` -- expected: exit 0.

## Auto Run Result

Status: done

**Summary:** `xarabot join --repo <owner>/<name> [--login <login>] [--port <n>]` creates the owner's `<login>-xarabot` GitHub App from a manifest, or checks an existing one. With no `app.json`, it serves the manifest form on `127.0.0.1`, opens GitHub's manifest page, checks the callback's `state` and converts the code with no token. It refuses an App whose owner or slug is not the caller's. It then writes `private-key.pem` (600) before `app.json` (`{id, slug, owner}`) in a 700 folder, and never prints the key. With a record, it creates nothing: it reads `GET /app` with Story 1.8's `createAppJwt` and stops on any missing, extra or different-level permission, naming each one and the permissions URL as a Human Live Step. `bootstrap/join.ts` is removed and the runbook points to `xarabot join`.

**Files changed:**
- `src/core/join/manifest.ts`: new and pure. The manifest's seven permissions, `appName`, `buildManifest`, the GitHub URLs, and `comparePermissions`.
- `src/adapters/forge/github/http.ts`: adds the operations `convertManifest` (`none`) and `getApp` (`app-jwt`).
- `src/adapters/forge/github/app-manifest.ts`: new. `convertManifest` and `readAppPermissions`, both through `request()`.
- `src/cli/join.ts`: new. The `join` command: the callback server, the deadline and SIGINT, the file writes and the re-run check.
- `src/cli/main.ts`: routes `join`.
- `test/adapters/forge/github/fake-github.ts`: adds `GET /app`, manifest conversions, `setAppPermissions` and `registerManifest`. `botLogin` is now derived from `appSlug`.
- `test/core/join/manifest.test.ts`, `test/adapters/forge/github/app-manifest.test.ts`, `test/cli/join.test.ts`, `test/cli/main.test.ts`: the manifest pin and every matrix row. Also the slug, write-failure, default-SIGINT and deadline-during-conversion cases, and the real `gh` fallback.
- `bootstrap/join.ts`: deleted.
- `docs/maintainer/self-host.md` §5: covers `xarabot join`, installing the App by hand for now, and what a re-run checks.

**Review findings:** 33 in total. 10 medium, 18 low and 5 false; none high.
- **Patches applied:** 5 groups. Three were medium:
  - Orphaned-App guidance, and no abort while a callback is being handled.
  - The slug check.
  - The missing tests.
  
  Two were low: the runbook wording and the fake's duplicated default.
- **Deferred:** none.
- **Rejected:** 13 low and 5 false. Each one's reason is in the Review Triage Log.

**Follow-up review recommendation:** `true`, because three medium entries were patched. The unverified risk is that the real-`Bun.serve` path, and its graceful stop delivering the callback reply to a real browser, run only as a `hostTest`. That test was skipped in this sandboxed session. Nothing in this run reached GitHub's real manifest page and conversion.

**Verification:**
- `bun test test/core/join test/cli/join.test.ts test/adapters/forge/github test/cli/main.test.ts`: 395 pass, 20 skip, 0 fail.
- `bun test`: 6568 pass, 400 skip, 0 fail.
- `bun --bun tsc`: exit 0.
- `bun --bun oxlint`: exit 0.

**Residual risks:**
- The host-only real-socket case still needs a run outside the sandbox (CI runs it).
- Installing the App and checking its reach are manual until Story 5.2.
- `bootstrap/loop/token.ts` and `bootstrap/loop/README.md` still name `bootstrap/join.ts` as the script that wrote the existing key.
