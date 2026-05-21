#!/usr/bin/env bash
# Compute ccache primary key + restore-keys from the LLVM ref being built.
#
# Usage:
#   bash compute_ccache_keys.sh <workflow_label> <runner_os>
#                               [--branch <name>]
#                               [--llvm-dir <path>]
#                               [--commit-file <path>]
#
# Writes to $GITHUB_OUTPUT:
#   key           per-run primary key (forces a write each run)
#   restore_keys  newline-separated fallback prefixes (most-specific first)
#
# Keys follow the layout `ccache-v2-<workflow>-<os>-<kind>-<id>-<run-id>`. The
# <kind>-<id> pair is derived from llvm_commit.txt by default — the actual
# LLVM source-of-truth — so every workflow targeting the same LLVM version
# shares a bucket (PR / push-to-main / release tag for the same llvmorg-X.Y.Z
# all hit each other's cache).
#
# kind / id pairs:
#   tag-llvmorg   <X>.<Y>.<Z>[-rcN]   llvm_commit.txt holds `llvmorg-X.Y.Z[-rcN]`
#   tag-commit    <YY>-<MM>-<DD>      llvm_commit.txt holds a hex commit SHA;
#                                     YYMMDD is the committer date of HEAD in the cloned LLVM checkout
#   branch        <name>              --branch override (weekly-llvm.yml) or non-tag/SHA llvm_commit.txt content
#
# weekly-llvm.yml passes `--branch main` because it rewrites llvm_commit.txt
# with whatever upstream ref it's testing (often LLVM main tip) — that ref isn't
# a stable cache identity, so weekly's writes pin to the branch-main bucket and
# rely on the broader fallbacks for restore hits.
#
# Fallback chain: same id → progressively broader same-kind prefixes →
# branch-main → workflow catch-all. Tag and branch builds both fall back to
# branch-main so fresh release tags inherit the latest weekly/main build state.
set -euo pipefail

WORKFLOW=
OS=
BRANCH_OVERRIDE=
LLVM_DIR="thirdparty/llvm-project"
COMMIT_FILE="llvm_commit.txt"

while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH_OVERRIDE="$2"; shift 2 ;;
    --llvm-dir) LLVM_DIR="$2"; shift 2 ;;
    --commit-file) COMMIT_FILE="$2"; shift 2 ;;
    --) shift; break ;;
    --*) echo "unknown flag: $1" >&2; exit 2 ;;
    *)
      if [ -z "$WORKFLOW" ]; then WORKFLOW="$1"
      elif [ -z "$OS" ]; then OS="$1"
      else echo "unexpected positional arg: $1" >&2; exit 2
      fi
      shift
      ;;
  esac
done

: "${WORKFLOW:?usage: $0 <workflow_label> <os> [--branch <name>]}"
: "${OS:?usage: $0 <workflow_label> <os> [--branch <name>]}"

PREFIX="ccache-v2-${WORKFLOW}-${OS}"
run_id="${GITHUB_RUN_ID:-0}"

sanitize() { printf '%s' "$1" | tr '/' '_'; }

extra=()

if [ -n "$BRANCH_OVERRIDE" ]; then
  source_label="--branch $BRANCH_OVERRIDE"
  branch=$(sanitize "$BRANCH_OVERRIDE")
  kind="branch"
  id="$branch"
  [ "$branch" != "main" ] && extra+=("${PREFIX}-branch-main-")
else
  source_label="$COMMIT_FILE"
  if [ -f "$COMMIT_FILE" ]; then
    REF=$(grep -v '^[[:space:]]*\(#\|$\)' "$COMMIT_FILE" | head -n1 | tr -d '[:space:]' || true)
  else
    REF=""
    echo "warning: $COMMIT_FILE not found; falling back to branch=main"
  fi

  if [[ "$REF" =~ ^llvmorg-([0-9]+)\.([0-9]+)\.([0-9]+)(-rc[0-9]+)?$ ]]; then
    X="${BASH_REMATCH[1]}"; Y="${BASH_REMATCH[2]}"; Z="${BASH_REMATCH[3]}"; RC="${BASH_REMATCH[4]:-}"
    kind="tag-llvmorg"
    id="${X}.${Y}.${Z}${RC}"
    # rc → stable of same X.Y.Z, then drop patch, minor, major suffixes in turn.
    [ -n "$RC" ] && extra+=("${PREFIX}-tag-llvmorg-${X}.${Y}.${Z}-")
    extra+=("${PREFIX}-tag-llvmorg-${X}.${Y}.")
    extra+=("${PREFIX}-tag-llvmorg-${X}.")
    extra+=("${PREFIX}-tag-llvmorg-")
    extra+=("${PREFIX}-branch-main-")
  elif [[ "$REF" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
    if [ -d "$LLVM_DIR/.git" ]; then
      YYMMDD=$(git -C "$LLVM_DIR" show -s --format=%cd --date=format:%y%m%d HEAD 2>/dev/null || true)
    else
      YYMMDD=""
    fi
    if [[ "$YYMMDD" =~ ^[0-9]{6}$ ]]; then
      YY="${YYMMDD:0:2}"; MM="${YYMMDD:2:2}"; DD="${YYMMDD:4:2}"
      kind="tag-commit"
      id="${YY}-${MM}-${DD}"
      extra+=("${PREFIX}-tag-commit-${YY}-${MM}-")
      extra+=("${PREFIX}-tag-commit-${YY}-")
      extra+=("${PREFIX}-tag-commit-")
      extra+=("${PREFIX}-branch-main-")
    else
      # SHA but no LLVM checkout to date it — fall back to a short-SHA bucket.
      kind="tag-commit"
      id="sha-${REF:0:12}"
      extra+=("${PREFIX}-tag-commit-")
      extra+=("${PREFIX}-branch-main-")
    fi
  elif [ -n "$REF" ]; then
    # Branch-name-ish content (e.g. local-dev edge cases, or weekly's `main`
    # written into llvm_commit.txt before --branch is applied).
    kind="branch"
    id=$(sanitize "$REF")
    [ "$id" != "main" ] && extra+=("${PREFIX}-branch-main-")
  else
    kind="branch"
    id="main"
  fi
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

echo "ccache keys (workflow=$WORKFLOW os=$OS source=$source_label):"
echo "  kind: $kind"
echo "  id:   $id"
echo "  key:  $primary"
echo "  restore-keys:"
printf '    %s\n' "${final[@]}"
