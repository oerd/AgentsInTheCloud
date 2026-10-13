#!/bin/bash
set -euo pipefail
# Publish an immutable System image and move latest (and with --stable, stable) to it.
cd "$(dirname "$0")/../.."
exec bun images/system/publish.ts "$@"
