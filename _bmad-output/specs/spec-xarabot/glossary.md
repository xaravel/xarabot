# Glossary

- **Unit:** one piece of work a lane takes: a Story, a retro, a retro action item, a planning step, or a checkpoint record.
- **Lane:** one long-running worker on a host, with its own worktree, state folder, scheduled job, agent and model.
- **Coordinator lane (lane 0):** the only lane that runs retros, retro action items and planning, and the only writer of `sprint-status.yaml` and `retro-gates.yaml`.
- **Builder lane (lanes 1..N):** a lane that builds Stories only.
- **Claim:** a lane's exclusive hold on a unit, made by compare-and-swap on a git ref, kept alive by heartbeat, expiring 30 minutes after the last heartbeat.
- **`next`:** the command that returns the one unit a lane builds next.
- **Adapter:** the code that runs one vendor's agent CLI for a unit and returns its JSON result.
- **Checkpoint Epic:** an Epic after whose retrospective the Maintainer must say "go" before later Epics start (Xaravel: Epic 8).
- **Retro gate:** the record of an Epic's retrospective verdict and its open action items (`retro-gates.yaml`).
- **Blocking action item:** a retro action item tagged `blocking`. It holds back the next Epic; untagged items do not.
- **Maintainer inbox:** the single list of everything waiting on the Maintainer.
- **Maintainer:** the human who owns the consuming repo's rulings, Protected Paths and releases.
- **Protected Path:** a path in the consuming repo that changes only through a Maintainer-approved Infrastructure Story (Xaravel AD-16).
- **Bot (`<login>-xarabot`):** the GitHub user account one human owns and is responsible for. All of that human's lanes commit, push and open PRs as it. It has no admin, bypass or approve rights.
- **Owner:** the human a bot belongs to. Their review makes the bot's PRs mergeable, Protected Path PRs included.
- **STOP marker:** the file that makes a lane, or every lane on a host, exit after its current unit.
