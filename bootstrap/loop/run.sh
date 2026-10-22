#!/bin/bash
# Xarabot bootstrap loop driver (SPEC "Bootstrap", spine AD-31). A copy of Xaravel's
# tools/orchestrator/run.sh, changed for Xarabot's Epic 1:
#   - it runs as the dedicated macOS user and acts only as the lane bot, with tokens it mints
#     from the App key (token.ts); the Claude session it starts gets no token and only builds;
#   - this driver, not the session, pushes, opens PRs, polls CI and merges, and it merges only
#     after the Maintainer's approving review on the PR's head commit, never with --admin;
#   - it builds only Epic 1's Stories, in file order, one per iteration;
#   - it runs from the installed copy in ~/.xarabot-bootstrap/ (install.sh), never from the
#     clone it builds, so a merged change to bootstrap/loop/ takes effect only when reinstalled.
# Each launch does one unit, sleeps, and re-execs the installed copy. STOP stops it.
set -uo pipefail

INSTALL="${XARABOT_BOOTSTRAP_HOME:-$HOME/.xarabot-bootstrap}"
export XARABOT_BOOTSTRAP_STATE="${XARABOT_BOOTSTRAP_STATE:-$INSTALL/state}"
export XARABOT_BOOTSTRAP_REPO="${XARABOT_BOOTSTRAP_REPO:-xaravel/xarabot}"
export XARABOT_BOOTSTRAP_APP="${XARABOT_BOOTSTRAP_APP:-edanisko-xarabot}"
STATE="$XARABOT_BOOTSTRAP_STATE"
GH_REPO="$XARABOT_BOOTSTRAP_REPO"
CLONE="${XARABOT_BOOTSTRAP_CLONE:-$HOME/repos/xarabot}"
MAINTAINER="${XARABOT_BOOTSTRAP_MAINTAINER:-edanisko}"
MODEL="${XARABOT_BOOTSTRAP_MODEL:-claude-opus-5-5}"
STATUS="_bmad-output/implementation-artifacts/sprint-status.yaml"
EPICS="_bmad-output/planning-artifacts/epics.md"
MARK="Opened by the Xarabot bootstrap loop."
SETTINGS='{"includeCoAuthoredBy":false,"attribution":{"commit":"","pr":""}}'
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "$STATE/logs" "$STATE/blocked" "$STATE/once"
chmod 700 "$STATE"

if [ -f "$STATE/env" ]; then set -a; . "$STATE/env"; set +a; fi
# Never let a GitHub token reach the session through the environment.
unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN
# The Claude credential, from `claude setup-token`, where the runner will read it too (AD-17).
cred="${XDG_CONFIG_HOME:-$HOME/.config}/xarabot/vendors/claude/oauth-token"
if [ -f "$cred" ]; then
  CLAUDE_CODE_OAUTH_TOKEN="$(tr -d '[:space:]' < "$cred")"
  export CLAUDE_CODE_OAUTH_TOKEN
fi

say() { echo "$(date -u +%FT%TZ) $*" | tee -a "$STATE/history"; }
again() { sleep "$1"; exec /bin/bash "$INSTALL/run.sh"; }
# gh and git as the bot, for this driver only: the token is passed per command, never exported.
ghb() { local t; t="$(bun "$INSTALL/token.ts")" || return 1; GH_TOKEN="$t" gh "$@"; }
gitb() { git -C "$CLONE" -c credential.helper= -c "credential.helper=$INSTALL/bin/bot-credential" "$@"; }
g() { git -C "$CLONE" "$@"; }
# Comment on a PR once per key, so a waiting PR isn't commented on every iteration.
comment_once() {
  local key="$1" n="$2" text="$3"
  [ -e "$STATE/once/$key" ] && return 0
  ghb pr comment "$n" --repo "$GH_REPO" --body "🤖 $text" >/dev/null && touch "$STATE/once/$key"
}

# Claude's usage-limit message ("You've hit your session limit · resets 11:50pm ...") gives the
# reset time; print it and the seconds to sleep until two minutes after it (at most 8 hours).
limit_wait() {
  local t target now secs
  t="$(grep -oE "hit your (session|usage) limit[^\"]{0,20}resets [0-9]{1,2}(:[0-9]{2})?(am|pm)" "$1" 2>/dev/null \
       | tail -1 | grep -oE '[0-9]{1,2}(:[0-9]{2})?(am|pm)$')"
  [ -n "$t" ] || return 1
  case "$t" in *:*) ;; *) t="${t%??}:00${t#${t%??}}" ;; esac
  target="$(date -j -f '%Y-%m-%d %I:%M%p' "$(date +%Y-%m-%d) $(echo "$t" | tr '[:lower:]' '[:upper:]')" +%s 2>/dev/null)" || return 1
  now="$(date +%s)"
  if [ "$target" -le "$now" ]; then
    if [ $((now - target)) -le 3600 ]; then echo "$t 120"; return 0; fi
    target=$((target + 86400))
  fi
  secs=$((target - now + 120))
  [ "$secs" -gt 28800 ] && secs=28800
  echo "$t $secs"
}

# Run one Claude session on a prompt in the clone. The session has no GitHub token.
session() {
  (cd "$CLONE" && claude -p "$1" --model "$MODEL" --permission-mode auto --add-dir "$STATE" \
      --output-format stream-json --verbose --settings "$SETTINGS") </dev/null >>"$log" 2>&1
}

# After a session with no valid result: sleep through a usage limit, or count a failed attempt.
failed_session() {
  local id="$1" wait n
  if wait="$(limit_wait "$log")"; then
    say "usage limit; sleeping ${wait#* }s until ${wait%% *}"
    again "${wait#* }"
  fi
  n=$(( $(cat "$STATE/attempts-$id" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$STATE/attempts-$id"
  if [ "$n" -ge 3 ]; then
    echo "3 sessions ended with no valid result; see $STATE/logs" > "$STATE/blocked/$id"
    say "Story $id blocked after 3 failed sessions; delete $STATE/blocked/$id to retry"
    again 1800
  fi
  say "Story $id: session $n failed with no valid result; see $log"
  again 900
}

# Commit messages may not carry attribution markers (AGENTS.md).
has_markers() { g log "origin/main..HEAD" --format=%B | grep -qiE '^(co-authored-by|generated with)|generated with \[?claude'; }

[ -e "$STATE/STOP" ] && { say "STOP file present; exiting"; exit 0; }
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then say "no Claude credential at $cred; stopping"; touch "$STATE/STOP"; exit 0; fi

log="$STATE/logs/$(date +%Y%m%d-%H%M%S).log"
ln -sf "$log" "$STATE/latest.log"

# An iteration that died mid-Story leaves its work uncommitted on story/*. Commit it there,
# locally and unpushed, before the reset below discards it; the next session resumes from it.
br="$(g symbolic-ref --short -q HEAD)"
case "$br" in
  story/*)
    if [ -n "$(g status --porcelain)" ]; then
      if g add -A >>"$log" 2>&1 && g commit -q -m "[bootstrap wip] $br: uncommitted work saved before reset" >>"$log" 2>&1; then
        say "saved uncommitted work on $br as $(g rev-parse --short HEAD) [bootstrap wip]"
      fi
    fi ;;
esac

if ! { g fetch -q --prune origin && g checkout -q -f main && g reset -q --hard origin/main && g clean -fdq; } >>"$log" 2>&1; then
  say "git sync failed; see $log"; again 900
fi

# Commits made in the clone are authored by the bot, so a session's own commits carry no
# human identity (the session's HOME has no git identity of its own).
if [ ! -s "$STATE/identity" ]; then
  bun "$INSTALL/token.ts" identity > "$STATE/identity" 2>>"$log" || { say "could not read the bot identity; see $log"; again 900; }
fi
g config user.name "$(cut -f1 "$STATE/identity")"
g config user.email "$(cut -f2 "$STATE/identity")"

# ---- A. An open bootstrap PR comes first: CI, CI fixes, the Maintainer's approval, merge. ----
prs="$(ghb pr list --repo "$GH_REPO" --state open --author "app/$XARABOT_BOOTSTRAP_APP" \
        --json number,headRefName,isDraft,title,body --limit 20 2>>"$log")" || { say "gh pr list failed; see $log"; again 900; }
pr="$(jq -c --arg m "$MARK" '[.[] | select((.body | contains($m)) and (.headRefName | startswith("story/")))] | .[0] // empty' <<<"$prs")"

if [ -n "$pr" ]; then
  n="$(jq -r .number <<<"$pr")"; branch="$(jq -r .headRefName <<<"$pr")"; id="${branch#story/}"
  title="$(jq -r .title <<<"$pr")"
  if [ "$(jq -r .isDraft <<<"$pr")" = "true" ]; then
    say "PR #$n ($branch) is a draft: blocked, waiting for the Maintainer"; again 1800
  fi
  view="$(ghb pr view "$n" --repo "$GH_REPO" --json mergeable,headRefOid,reviews,body 2>>"$log")" || again 900
  head="$(jq -r .headRefOid <<<"$view")"
  case "$(jq -r .mergeable <<<"$view")" in
    UNKNOWN) again 60 ;;
    CONFLICTING)
      # While a PR conflicts, GitHub runs only some checks: merge main into it first.
      if gitb fetch -q origin "$branch" >>"$log" 2>&1 && g checkout -q -B "$branch" "origin/$branch" \
         && g merge -q --no-edit origin/main >>"$log" 2>&1; then
        gitb push -q origin "$branch" >>"$log" 2>&1 && say "PR #$n: merged main into $branch"
        again 120
      fi
      g merge --abort >>"$log" 2>&1
      comment_once "conflict-$n-$head" "$n" "This PR conflicts with \`main\` and the merge needs a human. Holding until it is resolved."
      say "PR #$n conflicts with main; waiting for the Maintainer"; again 1800 ;;
  esac

  checks="$(ghb pr checks "$n" --repo "$GH_REPO" --json name,bucket 2>>"$log")"
  [ -n "$checks" ] || checks="[]"
  bad="$(jq '[.[] | select(.bucket == "fail")] | length' <<<"$checks")"
  pending="$(jq '[.[] | select(.bucket == "pending")] | length' <<<"$checks")"
  if [ "$(jq length <<<"$checks")" -eq 0 ] && ls "$CLONE"/.github/workflows/*.y*ml >/dev/null 2>&1; then
    pending=1   # workflows exist but no check has registered yet: an empty reply means pending
  fi

  if [ "$bad" -gt 0 ]; then
    fixes="$(g log "origin/main..origin/$branch" --format=%s 2>/dev/null | grep -c '^\[bootstrap fix\]')"
    if [ "$fixes" -ge 2 ]; then
      comment_once "cifail-$n-$head" "$n" "CI still fails after 2 fix sessions. Holding for the Maintainer."
      say "PR #$n: CI still fails after 2 fixes; waiting for the Maintainer"; again 1800
    fi
    : > "$STATE/ci-failed.log"
    for run in $(ghb run list --repo "$GH_REPO" --branch "$branch" --json databaseId,conclusion,headSha \
                   --jq ".[] | select(.headSha == \"$head\" and .conclusion == \"failure\") | .databaseId" 2>>"$log"); do
      ghb run view "$run" --repo "$GH_REPO" --log-failed >> "$STATE/ci-failed.log" 2>>"$log"
    done
    gitb fetch -q origin "$branch" >>"$log" 2>&1 && g checkout -q -B "$branch" "origin/$branch" || again 900
    result="$STATE/result.json"; rm -f "$result"
    say "PR #$n: CI failed; starting a CI-fix session ($((fixes + 1)) of 2)"
    session "Story: $id ($branch), PR #$n
Failing CI log: $STATE/ci-failed.log
Result file: $result

$(cat "$INSTALL/fix.md")"
    if [ "$(jq -r '.outcome // empty' "$result" 2>/dev/null)" = "done" ] && [ -n "$(g log "origin/$branch..HEAD" --format=%h)" ]; then
      if has_markers; then echo "a commit carries an attribution marker" > "$STATE/blocked/$id"; say "Story $id blocked: attribution marker in a commit"; again 1800; fi
      gitb push -q origin "$branch" >>"$log" 2>&1 && say "PR #$n: pushed a CI fix"
      again 120
    fi
    if [ "$(jq -r '.outcome // empty' "$result" 2>/dev/null)" = "blocked" ]; then
      comment_once "fixblocked-$n-$head" "$n" "The CI-fix session could not fix this: $(jq -r '.blocking // "no reason given"' "$result"). Holding for the Maintainer."
      say "PR #$n: CI fix blocked; waiting for the Maintainer"; again 1800
    fi
    failed_session "$id"
  fi
  if [ "$pending" -gt 0 ]; then say "PR #$n: checks pending"; again 300; fi

  # Green. Merge only with the Maintainer's approving review on this head commit.
  # The Maintainer's latest deciding review (comments don't count) must approve this head.
  reviews="$(ghb api "repos/$GH_REPO/pulls/$n/reviews?per_page=100" 2>>"$log")" || again 900
  approved="$(jq -r --arg m "$MAINTAINER" --arg h "$head" \
    '[.[] | select(.user.login == $m and (.state == "APPROVED" or .state == "CHANGES_REQUESTED" or .state == "DISMISSED"))]
     | last // {} | select(.state == "APPROVED" and .commit_id == $h) | "yes"' <<<"$reviews")"
  if [ "$approved" != "yes" ]; then
    say "PR #$n: green, waiting for @$MAINTAINER's approval on $head"; again 600
  fi
  body="$(jq -r .body <<<"$view")"
  if ! ghb pr merge "$n" --repo "$GH_REPO" --squash --subject "$title (#$n)" --body "${body%"$MARK"}" >>"$log" 2>&1; then
    comment_once "merge-$n-$head" "$n" "Merging was refused; see the loop's log. Holding for the Maintainer."
    say "PR #$n: merge refused; see $log"; again 1800
  fi
  for _ in $(seq 1 60); do
    [ "$(ghb pr view "$n" --repo "$GH_REPO" --json state --jq .state 2>>"$log")" = "MERGED" ] && { say "merged PR #$n: $title"; rm -f "$STATE/attempts-$id"; again 60; }
    sleep 30
  done
  say "PR #$n: not merged 30 minutes after the merge request"; again 300
fi

# ---- B. The next Epic 1 Story, in sprint-status file order. ----
key="$(awk '/^development_status:/ {f = 1; next}
            f && /^  1-[0-9]+[a-z]?-/ {k = $1; sub(":$", "", k); if ($2 != "done") {print k; exit}}' "$CLONE/$STATUS")"
if [ -z "$key" ]; then
  say "every Epic 1 Story is done; waiting for the self-host switch (Story 1.20's runbook)"
  touch "$STATE/STOP"; exit 0
fi
id="$(awk -F- '{print $1 "." $2}' <<<"$key")"
title="$(awk -v h="### Story $id: " 'index($0, h) == 1 {print substr($0, length(h) + 1); exit}' "$CLONE/$EPICS")"
branch="story/$id"
if [ -e "$STATE/blocked/$id" ]; then
  say "Story $id is blocked ($(cat "$STATE/blocked/$id")); delete $STATE/blocked/$id to retry"; again 1800
fi
[ -n "$title" ] || { say "no '### Story $id:' heading in $EPICS"; again 1800; }

# Resume a branch an earlier session left with wip commits; otherwise start from main.
if g rev-parse -q --verify "refs/heads/$branch" >/dev/null && [ -n "$(g log "origin/main..$branch" --format=%h)" ]; then
  g checkout -q "$branch" && g merge -q --no-edit origin/main >>"$log" 2>&1 || {
    g merge --abort >>"$log" 2>&1
    echo "the saved work on $branch conflicts with main" > "$STATE/blocked/$id"
    say "Story $id blocked: saved work on $branch conflicts with main"; again 1800; }
  say "Story $id: resuming saved work on $branch"
else
  g checkout -q -B "$branch" origin/main
fi

result="$STATE/result.json"; rm -f "$result"
say "Story $id: starting a build session ($key)"
session "Story: $id ($key): $title
Result file: $result

$(cat "$INSTALL/iteration.md")"

outcome="$(jq -r '.outcome // empty' "$result" 2>/dev/null)"
case "$outcome" in done|blocked) ;; *) failed_session "$id" ;; esac
[ "$(g symbolic-ref --short -q HEAD)" = "$branch" ] || { say "Story $id: the session left $branch"; failed_session "$id"; }
if [ -n "$(g status --porcelain)" ]; then g add -A && g commit -q -m "$id: changes the session left uncommitted"; fi
[ -n "$(g log "origin/main..HEAD" --format=%h)" ] || { say "Story $id: the session committed nothing"; failed_session "$id"; }
if has_markers; then echo "a commit carries an attribution marker" > "$STATE/blocked/$id"; say "Story $id blocked: attribution marker in a commit"; again 1800; fi

summary="$(jq -r '.summary // ""' "$result")"
details="$(jq -r '.body // ""' "$result")"
spec="$(jq -r '.spec // ""' "$result")"
gitb push -q --force-with-lease -u origin "$branch" >>"$log" 2>&1 || { say "Story $id: push failed; see $log"; again 900; }

if [ "$outcome" = "done" ]; then
  body="$summary

$details

Story spec: \`$spec\`

$MARK"
  ghb pr create --repo "$GH_REPO" --base main --head "$branch" --title "Story $id: $title" \
    --body "$body" --reviewer "$MAINTAINER" >>"$log" 2>&1 || { say "Story $id: gh pr create failed; see $log"; again 900; }
  rm -f "$STATE/attempts-$id"
  say "Story $id: PR opened for @$MAINTAINER's review"; again 60
fi

# Blocked: record the block as a draft PR, so the Maintainer sees the spec and the reason.
blocking="$(jq -r '.blocking // "no reason given"' "$result")"
echo "$blocking" > "$STATE/blocked/$id"
ghb pr create --repo "$GH_REPO" --base main --head "$branch" --draft --title "Story $id blocked: $title" \
  --body "Blocked: $blocking

$details

Story spec: \`$spec\`. Delete \`$STATE/blocked/$id\` on the host to retry.

$MARK" --reviewer "$MAINTAINER" >>"$log" 2>&1
say "Story $id blocked: $blocking"; again 1800
