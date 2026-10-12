#!/bin/bash
set -euo pipefail
context=$(cd "$(dirname "$0")" && pwd)
if [[ -n $(git -C "$context" status --porcelain -- .) ]]; then
    echo 'Commit changes in images/patched-docker before publishing.' >&2
    exit 1
fi
repository=ghcr.io/lucasmeijer/agents-in-the-cloud-docker
build_args=()
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --image ]]; then
    [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || { echo '--image requires a repository' >&2; exit 1; }
    repository="$2"
    shift 2
  else
    build_args+=("$1")
    shift
  fi
done
owner="$(bun "$context/../../scripts/ghcr-owner.ts" "$repository")"
token="${GH_PACKAGE_TOKEN:-}"
if [[ -z "$token" ]]; then
  echo 'GH_PACKAGE_TOKEN is required to publish images to ghcr.io' >&2
  exit 1
fi
printf '%s' "$token" | docker login ghcr.io --username "$owner" --password-stdin
revision=$(git -C "$context" rev-parse HEAD)
image="${repository}:sha-${revision}"
"$context/build.sh" "$image" --push \
    --label "org.opencontainers.image.revision=${revision}" "${build_args[@]}"
docker buildx imagetools inspect "$image"
