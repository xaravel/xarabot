# Releases

| Release | Capabilities | Gate |
|---|---|---|
| 0.x (Xaravel cutover) | CAP-1, CAP-2, CAP-3, CAP-4, CAP-5, CAP-6, CAP-7 (`claude`, `codex` and `pi`, with the common `model` and `effort` settings), CAP-9, CAP-10, CAP-11, CAP-12, CAP-13, CAP-15, CAP-22 | Xaravel's Epic 8 checkpoint "go" |
| v1 | CAP-8, CAP-14, CAP-17, CAP-18, CAP-19, CAP-20, CAP-21, CAP-23 | v1 success signal in SPEC.md |
| after v1 core | CAP-16 (pipelining), `grok` adapter | optional |

Placement notes:
- **CAP-7 and CAP-12** moved into 0.x by the Maintainer's decision (2026-10-20): all three adapters and the TUI ship before the cutover.
- **CAP-11** is in 0.x because the 0.x success signal is measured from its telemetry.
- **CAP-22** is in 0.x because Xaravel's loop already stops when its MAINT file is missing, and the cutover must keep that.
- **CAP-20 in Xaravel:** Xaravel already has hash-bound escalations (`tools/escalations/`). Under 0.x Xarabot reads them through config; v1 makes the mechanism Xarabot-owned.
- **CAP-8 in Xaravel:** Xaravel's loop already runs a cross-model Fidelity Review (Codex reviewing Claude-built Stories, `decisions/ESC-8.5-1.md`). Until v1, Xarabot keeps that working through the consuming repo's `bmad-build-auto` review layer.
