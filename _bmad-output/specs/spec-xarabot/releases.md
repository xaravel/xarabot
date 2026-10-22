# Releases

| Release | Capabilities | Gate |
|---|---|---|
| 0.x (Xaravel adoption) | CAP-1, CAP-2, CAP-3, CAP-4, CAP-5, CAP-6, CAP-7 (`claude`, `codex` and `pi`, with the common `model` and `effort` settings), CAP-8, CAP-9, CAP-10, CAP-11, CAP-12, CAP-13 (including `xarabot join`'s App creation), CAP-15, CAP-18 (sandbox and write check), CAP-22, CAP-24 (GitHub adapter) | Xaravel's adoption Epic, added before Epic 9 |
| v1 | CAP-14, CAP-17, CAP-18 (diff check on claim globs and dependency files, CI re-check), CAP-19, CAP-20, CAP-21, CAP-23, CAP-24 (local-only adapter) | v1 success signal in SPEC.md |
| after v1 core | CAP-16 (pipelining), `grok` adapter, GitLab and other forge adapters, the spec-folder planning shape (`stories.yaml`) | optional; the planning shape when a consumer uses it |

Placement notes (Maintainer decisions, 2026-10-20 unless dated):
- **CAP-7 and CAP-12** are in 0.x: all three adapters and the TUI ship before Xaravel adopts Xarabot.
- **CAP-8** is in 0.x because `codex` and `pi` lanes ship there and must not merge without a review from another vendor when the repo allows one; a single-vendor repo gets a same-vendor review instead (2026-10-21).
- **CAP-18's sandbox** is in 0.x because without it a lane's agent inherits the host's GitHub login. It is built in Xarabot's first Epic, under the bootstrap, because self-hosting waits for it (2026-10-21).
- **CAP-18's write check** is in 0.x so builders cannot write coordinator-owned files, manifests or agent config, or widen their own policy, before v1's diff check exists (2026-10-21).
- **CAP-13's App creation** is in 0.x because the bootstrap runs as `edanisko-xarabot`; `bootstrap/join.ts` covers it until `xarabot join` exists.
- **CAP-11** is in 0.x because the 0.x success signal is measured from its telemetry.
- **CAP-22** is in 0.x because Xaravel's loop already stops when its MAINT file is missing, and adoption must keep that.
- **CAP-20 in Xaravel:** Xaravel already has hash-bound escalations (`tools/escalations/`). Under 0.x Xarabot reads them through config with Xaravel's rule, and a Story with an open Escalation is neither claimed nor enqueued (2026-10-21); v1 makes the mechanism Xarabot-owned.
