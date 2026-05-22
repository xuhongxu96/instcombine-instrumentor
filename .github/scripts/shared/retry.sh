#!/usr/bin/env bash
#
# Retry a command a fixed number of times with linear backoff.
#
# Usage:
#   retry.sh [attempts] [sleep_seconds] -- <command> [args...]
#
# Example:
#   bash .github/scripts/shared/retry.sh 3 15 -- bash build_wasm.sh

set -euo pipefail

ATTEMPTS=${1:-3}
SLEEP_SECONDS=${2:-15}

if [ "$#" -lt 4 ] || [ "${3:-}" != "--" ]; then
    echo "usage: $0 [attempts] [sleep_seconds] -- <command> [args...]" >&2
    exit 2
fi

shift 3

if ! [[ "$ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
    echo "error: attempts must be a positive integer" >&2
    exit 2
fi

if ! [[ "$SLEEP_SECONDS" =~ ^[0-9]+$ ]]; then
    echo "error: sleep_seconds must be a non-negative integer" >&2
    exit 2
fi

attempt=1
while true; do
    echo "Attempt $attempt/$ATTEMPTS: $*"
    if "$@"; then
        exit 0
    fi

    if [ "$attempt" -ge "$ATTEMPTS" ]; then
        echo "Command failed after $ATTEMPTS attempts: $*" >&2
        exit 1
    fi

    delay=$((attempt * SLEEP_SECONDS))
    echo "Command failed on attempt $attempt/$ATTEMPTS; retrying in ${delay}s" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
done
