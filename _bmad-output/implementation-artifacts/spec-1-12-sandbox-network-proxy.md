---
title: 'Story 1.12: Sandbox network proxy'
type: 'feature'
created: '2026-10-23'
status: 'done'
baseline_revision: '3c59559e117248d815ef658e6796f8a4c027b8d0'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      CI never runs the proxy wiring inside Sandbox.run, because every macos.test.ts case is a sandboxTest and CI runs on ubuntu-latest.
    evidence: |-
      sandboxTest skips off darwin, and .github/workflows/ci.yml uses ubuntu-latest. Moving startProxy above buildAllowlist, or dropping the finally that stops the proxy, would pass CI. This is the same gap Story 1.11 deferred, and it needs a macOS CI job or a recorded host run (.github/ is Maintainer-only).
    location: >-
      src/sandbox/macos.ts
    severity: medium
  - summary: >-
      Nothing checks that the host has a uv-managed Python 3.11+, and uv can't download one inside a session, because its downloads come from GitHub, which the proxy refuses.
    evidence: |-
      Inside a session, uv finds Pythons only in the uv Python folder, which the session HOME links. With none installed, `uv run --python '>=3.11'` tries python-build-standalone on GitHub and fails with an unclear tunnel error. This host has it now (`uv python install 3.12`). A lane-start prerequisite check belongs to `xarabot lane install` (Story 1.19) or the runbook (Story 1.20).
    location: >-
      src/sandbox/tools.ts
    severity: medium
  - summary: >-
      Test suites that open local sockets (proxy.test.ts, and the existing git-server.ts) fail rather than skip when `bun test` runs inside a session.
    evidence: |-
      The session profile denies every network operation except outbound TCP to the proxy port, so Bun.listen and Bun.serve on 127.0.0.1 fail under XARABOT_SANDBOXED=1. test/adapters/forge/github/git-server.ts already has this problem from earlier Stories. A self-hosted lane running this repo's own `bun test` would see those cases fail. A fix needs a skip gate for socket-binding suites, or a decision on which suites a session runs.
    location: >-
      test/sandbox/proxy.test.ts
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Story 1.11's profile ends with `(deny network*)`, so a session has no network at all. It can't reach its vendor's API or PyPI, and nothing yet enforces the rule that a session never reaches GitHub by any route (FR18, NFR8, AR18, AR40, AD-17).

**Approach:**
- Add Xarabot's own Bun CONNECT proxy in `src/sandbox/`. It allows a fixed hostname allowlist: the vendor's API hosts, `pypi.org`, `files.pythonhosted.org` and the repo's `proxy_hosts`. A GitHub host or an IP literal is never allowed.
- `Sandbox.run` starts one proxy per session on `127.0.0.1`, points the proxy variables at it, and opens exactly that port in the profile. It stops the proxy when the session ends.
- Repo config that names a GitHub host is rejected when it loads.

## Boundaries & Constraints

**Always:**
- **Hosts (`src/core/network/hosts.ts`, pure).**
  - `normalizeHost` lower-cases a host and strips one trailing dot.
  - `isGitHubHost(host)` is true when the host equals, or ends in `.` plus, one of `github.com`, `githubusercontent.com`, `githubassets.com`, `github.io`, `githubapp.com`, `github.dev`, `githubcopilot.com`, `ghcr.io` or `ghe.com`. It is also true when any label contains `github`.
  - `isIpLiteral(host)` is true for a dotted IPv4 address, anything holding a `:` (IPv6), and a host whose last label is all digits.
  - `PACKAGE_HOSTS` = `pypi.org` and `files.pythonhosted.org`.
  - `buildAllowlist(vendorHosts, repoHosts)` returns the deduplicated, normalized list as `Result<readonly string[]>`. It refuses (`invalid`, with the host named) a GitHub host, an IP literal, `localhost` or `*.localhost`, and any entry that isn't a hostname.
- **Config.** `ConfigSchema.proxy_hosts` entries that `buildAllowlist` would refuse fail validation. The message says that a GitHub host is never allowed.
- **Port.** `LaunchSpec` gains a required `apiHosts: readonly string[]` (the vendor's API hosts, supplied by the adapter). `SandboxProfile` drops `proxyUrl` and gains an optional `repoHosts: readonly string[]` (the repo's `proxy_hosts`; default `[]`).
- **Proxy (`src/sandbox/proxy.ts`).**
  - `startProxy({allow, ports?, dial?})` listens on `127.0.0.1`, port 0, and returns `Result<{port, url, stop()}>`. `url` = `http://127.0.0.1:<port>`. `ports` defaults to `[443]`. `dial(host)` returns the address to connect to and defaults to the host itself; it exists for tests.
  - Each connection sends one request head, at most 8 KiB, within 10 s. The proxy answers with a status line, `Connection: close` and an empty body:
    - not `CONNECT` → 405;
    - an unparseable authority → 400;
    - an IP literal, a GitHub host, a host not on the allowlist, or a port not in `ports` → 403;
    - an upstream that fails to connect → 502;
    - an oversized head → 431, and a timeout just closes.
  - On an allowed request it connects upstream, replies `200 Connection Established`, forwards any bytes that followed the head, and pipes both ways. When a write can't complete, it buffers the rest and pauses the sending side until `drain`.
  - Either side closing ends the other. `stop()` closes the listener and every open socket. The proxy re-checks `isGitHubHost` and `isIpLiteral` on every request, whatever its allowlist holds.
  - The pure `decideConnect(head, allow, ports)` holds the decision.
- **Sandbox (`src/sandbox/macos.ts`).**
  - After its existing checks, the sandbox builds the allowlist from `spec.apiHosts` and `profile.repoHosts`. A failure is `refused`.
  - It starts the proxy, which is also `refused` on failure. Then it renders the profile with `proxyPort`, sets the four proxy variables to the proxy's `url`, and stops the proxy on every path after it started: refusal, spawn failure and exit.
  - `MacSandboxOpts.proxy?: {ports?, dial?}` passes test options through to `startProxy`.
- **Profile.** `renderProfile` takes an optional `proxyPort` (an integer from 1 to 65535, else `invalid`). When it's set, `(allow network-outbound (remote tcp "localhost:<port>"))` comes right after `(deny network*)`, so it is the profile's last rule. Without it, the profile is unchanged.

**Never:**
- No GitHub host and no IP literal on any allowlist, from any source. No plain-HTTP forwarding (`GET http://…`).
- No DNS from inside the sandbox: no `mDNSResponder` Mach service and no UDP.
- No unsandboxed fallback. If the proxy can't start, the session is refused.
- No new dependency. No `claude` hosts (Story 1.14 supplies them). No Linux.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Allowed host | `CONNECT api.vendor.test:<p>` with that host allowed, dialled to a local echo server | 200, then bytes round-trip | — |
| GitHub by name | `CONNECT github.com:443`, `api.github.com`, `raw.githubusercontent.com` | 403, no upstream dial | — |
| GitHub by IP | `CONNECT 140.82.112.3:443`, `[::1]:443` | 403 | — |
| Unlisted host | `CONNECT example.com:443` | 403 | — |
| Wrong port | an allowed host on port 22 | 403 | — |
| Not CONNECT | `GET http://pypi.org/ HTTP/1.1` | 405 | — |
| Upstream down | an allowed host whose dial target refuses | 502 | — |
| Config GitHub host | `proxy_hosts: [github.com]`, `[objects.githubusercontent.com]`, `[ghcr.io]`, `[1.2.3.4]`, `[localhost]` | config `invalid`, naming `proxy_hosts` | lane stops |
| Allowlist refuse | `apiHosts: ["api.github.com"]` | `refused`, nothing spawned, no proxy left listening | — |
| Sandbox bypass | in a session: TCP to a host-local port other than the proxy's; HTTPS to `140.82.112.3` with `--noproxy '*'` | both fail | — |
| Sandbox via proxy | in a session: a tunnel through `$HTTPS_PROXY` to an allowed fixture host | succeeds | — |

</intent-contract>

## Code Map

- `src/sandbox/profile.ts` `renderProfile`: section 9 is `(deny network*)`. The proxy rule goes after it, because Seatbelt's last matching rule wins.
- `src/sandbox/macos.ts` `createMacSandbox.run`: the checks are in order; the proxy starts after `renderProfile`'s inputs are known and before `seedVendorHome`. `validateProfile` checks `proxyUrl` today, and that check goes. `buildSessionEnv` keeps its `proxyUrl` part, which macos now fills from the proxy.
- `src/ports/sandbox.ts`: `LaunchSpec` and `SandboxProfile` (with the `proxyUrl` placeholder from 1.11).
- `src/core/schemas/config.ts:44` `Hostname`: add a refinement using `src/core/network/hosts.ts`. Core may import only core.
- `test/core/config/load-repo-config.test.ts:221`: the existing `proxy_hosts` invalid rows to extend.
- `test/sandbox/macos.test.ts`: the fake-home harness, plus `sh`, `ran` and `refusedWith`. The `spec()` helper needs `apiHosts`.
- `test/support/sandbox.ts` and `test/support/live.ts`: `sandboxTest` and `liveTest`. Add `liveSandboxTest`, which needs both.
- Host facts from the AR40 spike (macOS 27): with `(deny network*)` and then `(allow network-outbound (remote tcp "localhost:<P>"))`:
  - `curl telnet://127.0.0.1:<P>` connects.
  - `127.0.0.1:<other>` fails (curl 7).
  - `https://140.82.112.3` fails (curl 7). Unsandboxed, the same request gets 301.
  - `https://pypi.org` fails to resolve.
- This host has no uv-managed Python yet (only Homebrew's 3.14, which the sandbox can't read, and `/usr/bin/python3` 3.9). The `uv` live case needs `uv python install 3.12` run once on the host, outside the sandbox.
- Bun `Socket` has `pause()`, `resume()` and a `drain` handler, and `write` returns the bytes written.

## Tasks & Acceptance

**Execution:**
- `src/core/network/hosts.ts`: `normalizeHost`, `isGitHubHost`, `isIpLiteral`, `PACKAGE_HOSTS`, `GITHUB_DOMAINS` and `buildAllowlist`.
- `src/core/schemas/config.ts`: refine `proxy_hosts` entries.
- `src/ports/sandbox.ts`: `apiHosts` and `repoHosts`; drop `proxyUrl`.
- `src/sandbox/proxy.ts`: `decideConnect`, `startProxy` and `ProxyOpts`.
- `src/sandbox/profile.ts`: `proxyPort`.
- `src/sandbox/macos.ts`: the allowlist, the proxy lifecycle and `opts.proxy`.
- `test/core/network/hosts.test.ts`: case tables for every predicate and every `buildAllowlist` refusal.
- `test/core/config/load-repo-config.test.ts`: the matrix rows for config GitHub hosts.
- `test/sandbox/proxy.test.ts`: the proxy matrix rows against a local echo upstream (they run on any host), plus `stop()` closing open tunnels. A `liveTest` CONNECT to `pypi.org:443` gets 200.
- `test/sandbox/profile.test.ts`: the `proxyPort` rule and its order; an invalid port.
- `test/sandbox/macos.test.ts`: proxy variables in the env; the sandbox bypass and via-proxy rows; the allowlist refusal; the proxy port closed after `run`. A `liveSandboxTest` runs `uv run --no-cache --python '>=3.11' --with ruamel.yaml python -c 'import ruamel.yaml'` and expects exit 0.
- `test/support/sandbox.ts`: `liveSandboxTest`.

**Acceptance Criteria:**
- Given a session, when `Sandbox.run` starts it, then a proxy is listening for the session's lifetime, the session's proxy variables name it, the profile's only network allowance is its port, and after `run` resolves the port refuses connections.
- Given repo config whose `proxy_hosts` names any GitHub domain, when config loads, then it is `invalid`.
- Given `XARABOT_LIVE=1` on this macOS host with a uv-managed Python 3.11+, when the `uv` case runs, then it exits 0. Without `XARABOT_LIVE=1`, or with `XARABOT_SANDBOXED=1`, it is reported skipped.
- Given the repo, when `bun install`, `bun test`, `bun --bun oxlint` and `bun --bun tsc` run, then each exits 0.

## Spec Change Log

## Review Triage Log

### 2026-10-23 — Review pass
- verdicts: 19 findings — high 0, medium 3, low 16, false 0, maybe-false 0 (the intent-alignment audit is descriptive; its divergences a, d, e and f are logged under the matching findings below)
- findings:
  - `[low]` `[reject]` (edge) An upstream that closes before `tunnel` links it gets the client a 200 to a dead tunnel. — Bun runs the continuation after `await Bun.connect` before it delivers a close event, so this needs a FIN within the same tick. The client ends at the session's end. The fix adds a guard.
  - `[low]` `[reject]` (edge) A blackholed upstream has no dial timeout. — The OS connect timeout still ends in a 502, and the vendor and PyPI hosts aren't blackholed. The fix adds a timer.
  - `[low]` `[reject]` (edge) Seatbelt's `localhost` also matches `[::1]:<port>`, where another host process could listen. — It needs another process to bind the same ephemeral port number on `::1`. Seatbelt only takes `localhost` or `*` as the host, so the fix would be a second listener.
  - `[low]` `[patch]` (verification-gap) Bytes that arrive while the proxy is still dialling are untested. — Added a delayed-dial case that sends a second write before the 200.
  - `[medium]` `[defer]` (verification-gap) CI never runs the proxy wiring in `Sandbox.run` (ubuntu). — The same gap Story 1.11 deferred; `.github/` is Maintainer-only. Recorded in `deferred`.
  - `[low]` `[reject]` (verification-gap) `proxy_hosts` now accepts a trailing-dot host. — `buildAllowlist` normalizes it, so nothing goes wrong.
  - `[low]` `[reject]` (blind) A FIN from one side drops the bytes still coming back the other way. — Bun sockets don't allow half-open by default, so a FIN already closes the socket. curl, uv and Node clients don't half-close a tunnel. Support would mean `allowHalfOpen` and new state.
  - `[low]` `[reject]` (blind) A hostname that resolves to loopback or a private address reaches host or LAN services. — Allowed hosts are fixed vendor and PyPI names, or `proxy_hosts` on a Protected Path that only the Maintainer changes. The Design Notes record the DNS trade-off. A resolver check adds a new subsystem. (Also intent-alignment d.)
  - `[low]` `[reject]` (blind) The uv Python HOME link isn't in the spec. — The fix is a spec edit. The link is how the uv AC holds without leaving AD-17's env allowlist; Auto Run Result records it.
  - `[medium]` `[defer]` (blind) Nothing ensures a uv-managed Python exists, and uv can't download one through the proxy. — A host prerequisite for lane install or the runbook (Stories 1.19 and 1.20). Recorded in `deferred`. (Also intent-alignment e.)
  - `[low]` `[reject]` (blind) The proxy records no denials. — Neither the intent nor the spec asks for one, and the fix adds a port surface.
  - `[low]` `[reject]` (blind) There's no connection cap and no idle timeout on tunnels. — A session ends within its 3 h budget, and its proxy stops with it. The fix adds limits.
  - `[low]` `[patch]` (blind) `startProxy` and `decideConnect` don't re-check `localhost`. — Both now refuse `localhost` and `*.localhost`, with test rows.
  - `[low]` `[patch]` (blind) `gh.io` and `git.io` are missing from `GITHUB_DOMAINS`. — Added both, with test rows.
  - `[low]` `[patch]` (blind) The spawn-failure test asserts nothing when the run is refused. — It now asserts the actual outcome unconditionally.
  - `[low]` `[reject]` (blind) Nothing wires `proxy_hosts` and `apiHosts` into the sandbox. — The epic puts the `claude` hosts in Story 1.14 and the lane wiring in Story 1.16, and nothing launches sessions yet. (Also intent-alignment a.)
  - `[low]` `[reject]` (blind) The proxy listens on IPv4 only while the profile's `localhost` covers `::1`. — The same root cause as the edge `[::1]` row. The URL names `127.0.0.1`.
  - `[low]` `[reject]` (blind) Some header edge cases (bare LF, a leading CRLF, exactly 8 KiB) are untested. — Clients send canonical CRLF heads, and each edge case fails closed.
  - `[medium]` `[defer]` (intent-alignment f) Socket-binding suites fail rather than skip inside a session. — Already true of `git-server.ts`. Recorded in `deferred`.

## Design Notes

- **AR40 spike, done first.** Seatbelt filters by address and port only. The proxy is therefore the only hostname boundary, and the profile rule makes it the only route out. The spike above shows that the rule binds: a bypass and a raw GitHub IP both fail. These rows stay as permanent sandbox tests.
- **Stricter readings, all fail-closed:**
  - "Any other GitHub domain" is the known list plus any label containing `github`. A false positive such as `mygithubmirror.example` is refused, which is the safe side.
  - IP literals and `localhost` are refused in config as well. An IP could be GitHub's, and `localhost` would reach host services.
  - Only port 443 by default, and only `CONNECT`.
- **Accepted:** an allowed hostname resolves through the host's DNS, wherever it points. The hosts are fixed vendor and PyPI names, or repo config on a Protected Path.

## Verification

**Commands:**
- `bun test test/sandbox test/core/network test/core/config`: expected to pass, with the sandbox cases running on this host.
- `XARABOT_LIVE=1 bun test test/sandbox`: expected to pass, the `uv` and `pypi.org` cases included.
- `bun install && bun test && bun --bun oxlint && bun --bun tsc`: expected to exit 0.

## Auto Run Result

Status: done

**Summary.** Each session now gets its own Bun CONNECT proxy on `127.0.0.1`. The proxy allows only:
- the vendor's API hosts (`LaunchSpec.apiHosts`);
- `pypi.org` and `files.pythonhosted.org`;
- the repo's `proxy_hosts` (`SandboxProfile.repoHosts`).

The Seatbelt profile adds one rule after `(deny network*)`, which opens only that proxy's port. A GitHub host, an IP literal or `localhost` is refused at every layer: config validation, `buildAllowlist`, `startProxy` and each `CONNECT` request. The proxy stops on every path once it has started.

**AR40 spike.** The spike ran first, and the allowlist binds. Inside the sandbox:
- a direct TCP connection to another host-local port fails;
- HTTPS to the GitHub IP `140.82.112.3` fails, though the unsandboxed host reaches it (301);
- DNS doesn't resolve.

These checks stay in the suite as permanent sandbox tests.

**Beyond the spec: uv Python link.** Inside a session, uv couldn't find the host's uv-managed Python, because the session `HOME` is fresh. Passing `UV_PYTHON_INSTALL_DIR` would go beyond AD-17's env allowlist. Instead, `resolveTools` now reports the real uv Python folder (`uvPython`), and the sandbox links it at `<HOME>/.local/share/uv/python`. The profile already allowed reads of that folder. As a one-time host step, `uv python install 3.12` was run on this host outside the sandbox.

**Files changed:**
- `src/core/network/hosts.ts` (new): pure host predicates, `GITHUB_DOMAINS` (including `gh.io` and `git.io`), `PACKAGE_HOSTS`, `refuseHost` and `buildAllowlist`.
- `src/core/schemas/config.ts`: `proxy_hosts` entries are checked with `refuseHost`, so a GitHub host is never allowed.
- `src/ports/sandbox.ts`: `LaunchSpec.apiHosts` (required), and `SandboxProfile.repoHosts` in place of the `proxyUrl` placeholder.
- `src/sandbox/proxy.ts` (new): `decideConnect` and `startProxy`. Covers CONNECT only, the 405/400/403/431/502 answers, an 8 KiB head limit with a 10 s timeout, backpressure, close propagation and `stop()`.
- `src/sandbox/profile.ts`: `proxyPort` and its rule as the last line of the profile.
- `src/sandbox/macos.ts`: the allowlist, the proxy lifecycle (stopped in `finally`), the proxy variables, the `opts.proxy` test hooks and the uv Python `HOME` link.
- `src/sandbox/tools.ts`: `ResolvedTools.uvPython`.
- `test/core/network/hosts.test.ts`, `test/sandbox/proxy.test.ts` (new); `test/core/config/load-repo-config.test.ts`, `test/sandbox/{profile,macos}.test.ts` and `test/support/sandbox.ts` (`liveSandboxTest`).

**Review.** 19 findings:
- 4 patches, all low:
  - the proxy's own checks now refuse `localhost`;
  - added `gh.io` and `git.io`;
  - the spawn-failure test asserts its outcome unconditionally;
  - a new test covers bytes sent while the proxy is dialling. With the buffering line deleted, that test fails.
- 3 deferred, all medium:
  - CI never runs the macOS wiring;
  - nothing checks that the host has a uv-managed Python;
  - suites that open local sockets fail rather than skip inside a session.
- 12 rejected, all low, each with its reason in the triage log.

**Incident during the patch round.** The implementation subagent ran `cp src/sandbox/proxy.ts /tmp/p.bak; …; cp /tmp/p.bak src/sandbox/proxy.ts`. The first `cp` failed, because another user (`ea`) already owned `/tmp/p.bak`. The restore still ran, and it copied that user's unrelated file over `proxy.ts`. A later restore from the intent-to-add index then emptied it. `proxy.ts` was rebuilt from the review diff, and the round's listed edits were re-applied. Then the full suite, the live cases and a mutation check ran again. A foreign `/tmp/p.bak` owned by another account on this host is worth the Maintainer's attention.

**Follow-up review recommended: false.** Every patch this pass was low.

**Verification.** `bun install`, `bun test` (1627 pass, 60 skip, 0 fail), `bun --bun oxlint` and `bun --bun tsc` all exit 0. `XARABOT_LIVE=1 bun test test/sandbox test/core/network test/core/config` gives 470 pass and 0 fail, with the live `uv run --no-cache … ruamel.yaml` session case and `CONNECT pypi.org:443` included. The sandbox cases ran for real on this macOS 27 host.

**Residual risks:**
- An allowed hostname is dialled wherever its DNS points; no resolved-address check.
- Seatbelt's `localhost:<port>` also matches `[::1]:<port>`, where the proxy doesn't listen.
- There's no dial timeout and no tunnel idle timeout.
- The `claude` hosts (Story 1.14) and the lane wiring of `proxy_hosts` (Story 1.16) are still to come.
