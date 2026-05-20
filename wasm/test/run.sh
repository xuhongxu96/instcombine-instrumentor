#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
exec node wasm/test/smoke_wasm.mjs "$@"
