#!/bin/bash
set -euo pipefail
context=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$context/../.." && pwd)
if [[ -n $(git -C "$context" status --porcelain -- .) ]]; then
    echo 'Commit changes in images/patched-docker before publishing.' >&2
    exit 1
fi
owner=$(cd "$root" && bun -e 'import { registryOwnerFrom } from "./packages/core/src/ghcr.ts"; const origin = Bun.spawnSync(["git","remote","get-url","origin"], { stdout: "pipe", stderr: "pipe" }); const url = origin.exitCode === 0 ? origin.stdout.toString().trim() : undefined; process.stdout.write(registryOwnerFrom(Bun.env, url));')
token="${GH_PACKAGE_TOKEN:-}"
if [[ -z "$token" ]]; then
  echo 'GH_PACKAGE_TOKEN is required to publish images to ghcr.io' >&2
  exit 1
fi
printf '%s' "$token" | docker login ghcr.io --username "$owner" --password-stdin
revision=$(git -C "$context" rev-parse HEAD)
image="ghcr.io/${owner}/agents-in-the-cloud-docker:sha-${revision}"
"$context/build.sh" "$image" --push \
    --label "org.opencontainers.image.revision=${revision}" "$@"
docker buildx imagetools inspect "$image"
