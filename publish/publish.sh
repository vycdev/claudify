#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
env_path=${CLAUDIFY_PUBLISH_ENV:-"$script_dir/.env"}

if [ ! -f "$env_path" ]; then
  env_path="$script_dir/default.env"
fi

while IFS='=' read -r name value; do
  case "$name" in
    REGISTRY) REGISTRY=$value ;;
    USERNAME) USERNAME=$value ;;
    PASSWORD) PASSWORD=$value ;;
    IMAGE_NAME) IMAGE_NAME=$value ;;
    IMAGE_TAG) IMAGE_TAG=$value ;;
    ""|\#*) ;;
  esac
done < "$env_path"

: "${REGISTRY:?REGISTRY is required}"
: "${IMAGE_NAME:?IMAGE_NAME is required}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"

username=${USERNAME:-}
password=${PASSWORD:-}
image="$REGISTRY/$IMAGE_NAME:$IMAGE_TAG"

if [ -n "$username" ] || [ -n "$password" ]; then
  if [ -z "$username" ] || [ -z "$password" ]; then
    echo "USERNAME and PASSWORD must either both be set or both be empty." >&2
    exit 1
  fi
  printf '%s' "$password" | docker login "$REGISTRY" \
    --username "$username" \
    --password-stdin
else
  echo "No registry credentials configured; using anonymous registry access."
fi

echo "Building $image from $repo_root..."
docker build --pull --tag "$image" "$repo_root"

echo "Pushing $image..."
docker push "$image"

echo "Published $image"
