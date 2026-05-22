#!/usr/bin/env bash
# Resolve wasm-publish.yml's mode + inputs from the triggering event and emit
# them as `<key>=<value>` lines to $GITHUB_OUTPUT (or stdout if unset). The
# workflow's later steps read these to know which mode to run in and which
# operator-supplied knobs apply.
#
# Schedules don't carry workflow_dispatch inputs, so we encode the mode in the
# cron expression — '0 5 * * 1' = weekly-stable, '0 6 * * *' = daily-main.
#
# Env:
#   EVENT                — github.event_name
#   SCHEDULE             — github.event.schedule (empty if not a scheduled run)
#   INPUT_MODE           — workflow_dispatch input
#   INPUT_LLVM_REF       — workflow_dispatch input
#   INPUT_MAX_TAGS       — workflow_dispatch input
#   INPUT_PRUNE_MAIN     — workflow_dispatch input
#   INPUT_FORCE_REBUILD  — workflow_dispatch input
#   INPUT_DRY_RUN        — workflow_dispatch input

set -euo pipefail

OUT=${GITHUB_OUTPUT:-/dev/stdout}

MODE=""
if [ "${EVENT:-}" = "schedule" ]; then
    case "${SCHEDULE:-}" in
        "0 5 * * 1") MODE=weekly-stable ;;
        "0 6 * * *") MODE=daily-main ;;
        *) echo "unknown cron schedule: ${SCHEDULE:-}" >&2; exit 2 ;;
    esac
else
    MODE=${INPUT_MODE:-specific-ref}
fi

{
    echo "mode=$MODE"
    echo "llvm_ref=${INPUT_LLVM_REF:-}"
    echo "max_tags=${INPUT_MAX_TAGS:-3}"
    echo "prune_main=${INPUT_PRUNE_MAIN:-7}"
    echo "force_rebuild=${INPUT_FORCE_REBUILD:-false}"
    echo "dry_run=${INPUT_DRY_RUN:-false}"
} >> "$OUT"

echo "Resolved mode: $MODE"
