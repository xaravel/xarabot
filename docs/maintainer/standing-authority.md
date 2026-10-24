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
