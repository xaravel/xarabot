---
schema_version: 1
granted_by: edanisko
granted_at: 2026-10-24
repo: xaravel/xarabot
---

I, edanisko, let Xarabot's lanes on the Xarabot host build the Stories that
`next` picks in xaravel/xarabot: claim them on `xarabot/claims`, push
`story/<id>` branches as `edanisko-xarabot[bot]`, open and update their PRs,
and poll CI. A lane adds a PR to the merge queue only when none of its paths
needs my approval. Until Epic 3 merges, every path needs it, so every PR parks
awaiting my approving review, and I approve it and add it to the merge queue
by hand.

One exemption: a coordinator's `reconcile` PR, which holds only runner-written
status content and no agent change, skips that approval. Once its CI passes,
the runner re-checks this file, fences and adds it to the merge queue itself
(Story 2.5).
