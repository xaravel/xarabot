#!/bin/bash
# Installs the bootstrap loop into ~/.xarabot-bootstrap/ from a reviewed commit of the clone
# (default: origin/main), never from its working tree. Run it as the bootstrap user, after
# `git -C ~/repos/xarabot fetch`. Re-run it to pick up a merged change to bootstrap/loop/.
#
#   bash ~/repos/xarabot/bootstrap/loop/install.sh [<commit>]
set -euo pipefail

INSTALL="${XARABOT_BOOTSTRAP_HOME:-$HOME/.xarabot-bootstrap}"
CLONE="${XARABOT_BOOTSTRAP_CLONE:-$HOME/repos/xarabot}"
REF="${1:-origin/main}"
sha="$(git -C "$CLONE" rev-parse --verify "$REF^{commit}")"

mkdir -p "$INSTALL/bin" "$INSTALL/state"
chmod 700 "$INSTALL" "$INSTALL/state"
for f in run.sh iteration.md fix.md token.ts bin/bot-credential; do
  git -C "$CLONE" show "$sha:bootstrap/loop/$f" > "$INSTALL/$f.new"
  mv -f "$INSTALL/$f.new" "$INSTALL/$f"
done
chmod 755 "$INSTALL/run.sh" "$INSTALL/bin/bot-credential"
echo "$sha" > "$INSTALL/INSTALLED"
echo "Installed the bootstrap loop from $sha into $INSTALL."
