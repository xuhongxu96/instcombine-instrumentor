#!/usr/bin/env bash
# Compute ccache primary key + restore-keys for the current GitHub event.
#
# Usage: bash compute_ccache_keys.sh <workflow_label> <runner_os>
#
# Writes to $GITHUB_OUTPUT:
#   key           per-run primary key (forces a write each run)
#   restore_keys  newline-separated fallback prefixes (most-specific first)
#
# Keys follow the layout
#   ccache-<workflow>-<os>-<kind>-<id>-<run-id>
# so ccache state can be matched against progressively broader buckets without
# ever colliding the per-run save.
#
# kind / id pairs:
#   branch        <branch-name>         push/PR/dispatch on a branch (PR uses head ref)
#   tag-llvmorg   <X>.<Y>.<Z>[-rcN]     release/llvmorg-X.Y.Z[-rcN]    → falls back X.Y.Z → X.Y → X
#   tag-commit    <YY>-<MM>-<DD>        release/<YYMMDD>-<12hex>       → falls back YY-MM-DD → YY-MM → YY
#   tag-other     <sanitized-tag>       any other release/* tag
#
# Tag builds also fall back to the branch-main cache before the catch-all so a
# brand-new release tag inherits the most-recent main build state.
set -euo pipefail

WORKFLOW="${1:?usage: $0 <workflow_label> <os>}"
OS="${2:?usage: $0 <workflow_label> <os>}"
PREFIX="ccache-${WORKFLOW}-${OS}"

event="${GITHUB_EVENT_NAME:-}"
ref_type="${GITHUB_REF_TYPE:-}"
ref_name="${GITHUB_REF_NAME:-}"
head_ref="${GITHUB_HEAD_REF:-}"
run_id="${GITHUB_RUN_ID:-0}"

sanitize() { printf '%s' "$1" | tr '/' '_'; }

extra=()

if [ "$event" = "pull_request" ]; then
  branch=$(sanitize "${head_ref:-unknown}")
  kind="branch"
  id="$branch"
  [ "$branch" != "main" ] && extra+=("${PREFIX}-branch-main-")
elif [ "$ref_type" = "tag" ]; then
  tag="${ref_name#release/}"
  if [[ "$tag" =~ ^llvmorg-([0-9]+)\.([0-9]+)\.([0-9]+)(-rc[0-9]+)?$ ]]; then
    X="${BASH_REMATCH[1]}"; Y="${BASH_REMATCH[2]}"; Z="${BASH_REMATCH[3]}"; RC="${BASH_REMATCH[4]:-}"
    kind="tag-llvmorg"
    id="${X}.${Y}.${Z}${RC}"
    # rc → stable of same X.Y.Z, then drop patch, minor, major suffixes in turn.
    [ -n "$RC" ] && extra+=("${PREFIX}-tag-llvmorg-${X}.${Y}.${Z}-")
    extra+=("${PREFIX}-tag-llvmorg-${X}.${Y}.")
    extra+=("${PREFIX}-tag-llvmorg-${X}.")
    extra+=("${PREFIX}-tag-llvmorg-")
    extra+=("${PREFIX}-branch-main-")
  elif [[ "$tag" =~ ^([0-9]{2})([0-9]{2})([0-9]{2})-[0-9a-fA-F]+$ ]]; then
    YY="${BASH_REMATCH[1]}"; MM="${BASH_REMATCH[2]}"; DD="${BASH_REMATCH[3]}"
    kind="tag-commit"
    id="${YY}-${MM}-${DD}"
    extra+=("${PREFIX}-tag-commit-${YY}-${MM}-")
    extra+=("${PREFIX}-tag-commit-${YY}-")
    extra+=("${PREFIX}-tag-commit-")
    extra+=("${PREFIX}-branch-main-")
  else
    kind="tag-other"
    id=$(sanitize "$tag")
    extra+=("${PREFIX}-branch-main-")
  fi
elif [ "$ref_type" = "branch" ]; then
  branch=$(sanitize "$ref_name")
  kind="branch"
  id="$branch"
  [ "$branch" != "main" ] && extra+=("${PREFIX}-branch-main-")
else
  kind="ref"
  id=$(sanitize "${ref_name:-unknown}")
fi

primary="${PREFIX}-${kind}-${id}-${run_id}"

# Most-specific same-id prefix first, then incremental fallbacks, then catch-all.
final=("${PREFIX}-${kind}-${id}-")
[ ${#extra[@]} -gt 0 ] && final+=("${extra[@]}")
final+=("${PREFIX}-")

{
  echo "key=$primary"
  echo "restore_keys<<EOF"
  printf '%s\n' "${final[@]}"
  echo "EOF"
} >> "$GITHUB_OUTPUT"

echo "ccache keys for event=$event ref_type=${ref_type:-?} ref=${ref_name:-?}:"
echo "  kind: $kind"
echo "  id:   $id"
echo "  key:  $primary"
echo "  restore-keys:"
printf '    %s\n' "${final[@]}"
