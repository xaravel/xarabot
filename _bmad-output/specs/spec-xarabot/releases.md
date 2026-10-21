# Releases

| Release | Capabilities | Gate |
|---|---|---|
| 0.x (Xaravel adoption) | CAP-1, CAP-2, CAP-3, CAP-4, CAP-5, CAP-6, CAP-7 (`claude`, `codex` and `pi`, with the common `model` and `effort` settings), CAP-8, CAP-9, CAP-10, CAP-11, CAP-12, CAP-13, CAP-15, CAP-18 (sandbox only), CAP-22 | Xaravel's adoption Epic, added before Epic 9 |
| v1 | CAP-14, CAP-17, CAP-18 (diff check and CI re-check), CAP-19, CAP-20, CAP-21, CAP-23 | v1 success signal in SPEC.md |
| after v1 core | CAP-16 (pipelining), `grok` adapter | optional |

Placement notes (Maintainer decisions, 2026-10-20):
- **CAP-7 and CAP-12** are in 0.x: all three adapters and the TUI ship before Xaravel adopts Xarabot.
- **CAP-8** is in 0.x because `codex` and `pi` lanes ship there and must not merge without a review from another vendor.
- **CAP-18's sandbox** is in 0.x because without it a lane's agent inherits the host's GitHub login.
- **CAP-11** is in 0.x because the 0.x success signal is measured from its telemetry.
- **CAP-22** is in 0.x because Xaravel's loop already stops when its MAINT file is missing, and adoption must keep that.
- **CAP-20 in Xaravel:** Xaravel already has hash-bound escalations (`tools/escalations/`). Under 0.x Xarabot reads them through config; v1 makes the mechanism Xarabot-owned.
