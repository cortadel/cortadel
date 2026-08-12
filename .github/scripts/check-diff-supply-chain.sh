#!/usr/bin/env bash
# Supply-chain sanity check over the PR's own diff — see .github/workflows/pr.yml's
# supply-chain-diff job, which is the only caller in CI. Split into its own script (rather than an
# inline `run:` block) specifically so it can be exercised locally against two arbitrary git refs
# without needing a real pull_request event — see .superpowers/sdd's pr-gate report for the
# deliberate-desync proof this was run against before being wired into pr.yml.
#
# Deliberately operates on `git diff`, not a full checkout-and-scan of the PR head: it only flags
# lines the PR itself *adds* (a `+` line in unified diff), never pre-existing content already on
# the base branch. That matters because main, as of this script's authoring, still has several
# not-yet-pinned `uses: foo@v4`-style refs (chore/harden-workflows, PR #11, hasn't merged) — a
# whole-file scan would fail every PR gate run until that separate PR lands. Scoping to added lines
# only means this job is silent about pre-existing content and only ever objects to what a given PR
# newly introduces.
set -euo pipefail

BASE="${1:?usage: check-diff-supply-chain.sh <base-ref> <head-ref>}"
HEAD="${2:?usage: check-diff-supply-chain.sh <base-ref> <head-ref>}"

fail=0

# Triple-dot: diffs the base branch against the PR's changes specifically (merge-base..head),
# matching what GitHub's own "Files changed" tab shows — not a direct two-ref diff, which would
# also include commits landed on the base branch after the PR forked from it.
WORKFLOW_DIFF="$(git diff --unified=0 "$BASE...$HEAD" -- '.github/workflows/*.yml' || true)"
FULL_DIFF="$(git diff --unified=0 "$BASE...$HEAD" || true)"

# 1. pull_request_target. Anchored to the start of the (trimmed) added line so this only matches
# an actual YAML trigger key (`pull_request_target:`), never the word appearing inside a comment or
# sentence — e.g. this repo's own pr.yml explains the ban in prose without tripping this check.
PRT_HIT="$(printf '%s\n' "$WORKFLOW_DIFF" | grep -E '^\+[[:space:]]*pull_request_target[[:space:]]*:' || true)"
if [ -n "$PRT_HIT" ]; then
  echo "::error::This PR adds the 'pull_request_target' trigger to a workflow. Fork PRs in this repo run with no secrets and a read-only GITHUB_TOKEN by design — no workflow here uses pull_request_target, and adding it grants untrusted fork code both. Remove it (use 'pull_request' instead, or move privileged steps to a separate workflow_run gate)."
  printf '%s\n' "$PRT_HIT"
  fail=1
fi

# 2. Unpinned `uses:` refs. Every action reference in this repo's workflows is pinned to a full
# 40-character commit SHA with a `# vX.Y.Z` comment (chore/harden-workflows) — this fails on any
# newly-added `uses:` line whose ref isn't a 40-hex-char SHA. Local/composite refs (`uses: ./...`)
# and Docker image refs (`uses: docker://...`) never match the `@` capture below, so they're
# naturally exempt (neither carries the ref-pinning risk this check targets).
UNPINNED="$(printf '%s\n' "$WORKFLOW_DIFF" | grep -E '^\+' | grep -E 'uses:[[:space:]]*[^[:space:]]+@' | grep -vE '@[0-9a-f]{40}([[:space:]#]|$)' || true)"
if [ -n "$UNPINNED" ]; then
  echo "::error::This PR adds a workflow 'uses:' reference that isn't pinned to a full commit SHA. Pin it (uses: owner/repo@<40-char-sha> # vX.Y.Z) — check the action's release page for the SHA behind the tag you want, matching the style every other workflow in this repo already uses:"
  printf '%s\n' "$UNPINNED"
  fail=1
fi

# 3. Obvious committed credentials. Deliberately narrow, fixed high-signal patterns only — an AWS
# access key id, a PEM private key header, a GitHub PAT, or a Slack token. Not a general secret
# scanner: matching on entropy or generic KEY=/SECRET= assignments flags a contributor's test
# fixtures and first PR as often as it flags a real leak, which is worse than the gap it closes.
# Scans the whole diff (not just workflows) since a credential can land in any file.
CRED_PATTERN='AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}'
CRED_HIT="$(printf '%s\n' "$FULL_DIFF" | grep -E '^\+' | grep -E "$CRED_PATTERN" || true)"
if [ -n "$CRED_HIT" ]; then
  echo "::error::This PR appears to add a committed credential (AWS access key id, PEM private key, or a GitHub/Slack token). If this is a false positive, adjust the pattern in .github/scripts/check-diff-supply-chain.sh and say so in the PR description. If it's real: rotate it now, then remove it (a follow-up commit isn't enough — it stays in git history)."
  # Partially redact the matched secret itself before it lands in a public Actions log.
  printf '%s\n' "$CRED_HIT" | sed -E \
    -e 's/(AKIA[0-9A-Z]{6})[0-9A-Z]{10}/\1**********/g' \
    -e 's/(gh[pousr]_[A-Za-z0-9]{6})[A-Za-z0-9]{30}/\1**********/g' \
    -e 's/(github_pat_[A-Za-z0-9_]{10})[A-Za-z0-9_]{10,}/\1**********/g' \
    -e 's/(xox[baprs]-[A-Za-z0-9-]{6})[A-Za-z0-9-]{4,}/\1**********/g'
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "Supply-chain diff sanity OK: no pull_request_target, no newly-unpinned 'uses:' refs, no obvious committed credentials."
fi
exit $fail
