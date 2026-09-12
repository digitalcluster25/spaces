#!/usr/bin/env bash
set -euo pipefail

repo_dir="/opt/spaces/repo"
site_dir="/opt/spaces/site"
revision_file="/opt/spaces/deployed-revision"
lock_file="/opt/spaces/deploy.lock"

exec 9>"$lock_file"
flock -n 9 || exit 0

cd "$repo_dir"

git fetch origin main
remote="$(git rev-parse origin/main)"
deployed=""

if [ -f "$revision_file" ]; then
  deployed="$(cat "$revision_file")"
fi

if [ "$deployed" = "$remote" ] && [ -f "$site_dir/index.html" ]; then
  exit 0
fi

git reset --hard origin/main
if [ ! -d node_modules ]; then
  npm ci --no-audit --no-fund
fi
npm run build
rsync -a --delete dist/ "$site_dir/"
install -m 0644 infrastructure/spaces-site/docker-compose.yml /opt/spaces/docker-compose.yml
install -m 0644 infrastructure/spaces-site/nginx.conf /opt/spaces/nginx.conf
docker compose -f /opt/spaces/docker-compose.yml up -d

outline_hash="$(sha256sum infrastructure/outline-spaces-sso/server.js infrastructure/outline-spaces-sso/docker-compose.override.yml | sha256sum | cut -d' ' -f1)"
if [ "$(cat /opt/outline/spaces-sso-revision 2>/dev/null || true)" != "$outline_hash" ]; then
  install -m 0644 infrastructure/outline-spaces-sso/server.js /opt/outline/spaces-sso/server.js
  install -m 0644 infrastructure/outline-spaces-sso/docker-compose.override.yml /opt/outline/docker-compose.override.yml
  docker compose -f /opt/outline/docker-compose.yml -f /opt/outline/docker-compose.override.yml up -d --force-recreate spaces-sso
  printf '%s\n' "$outline_hash" > /opt/outline/spaces-sso-revision
fi

openseo_sso_hash="$(sha256sum infrastructure/openseo-spaces-sso/server.js infrastructure/openseo-spaces-sso/docker-compose.sso.yml | sha256sum | cut -d' ' -f1)"
if [ "$(cat /opt/openseo/spaces-sso-revision 2>/dev/null || true)" != "$openseo_sso_hash" ]; then
  install -m 0644 infrastructure/openseo-spaces-sso/server.js /opt/openseo/spaces-sso/server.js
  install -m 0644 infrastructure/openseo-spaces-sso/docker-compose.sso.yml /opt/openseo/docker-compose.sso.yml
  docker compose -f /opt/openseo/docker-compose.yml -f /opt/openseo/docker-compose.sso.yml up -d --force-recreate spaces-sso
  printf '%s\n' "$openseo_sso_hash" > /opt/openseo/spaces-sso-revision
fi

openseo_patch_hash="$(find infrastructure/openseo-patches -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"
if [ "$(cat /opt/openseo/spaces-patch-revision 2>/dev/null || true)" != "$openseo_patch_hash" ]; then
  if ! docker image inspect openseo-spaces:base-20260912 >/dev/null 2>&1; then
    docker tag openseo-spaces:latest openseo-spaces:base-20260912
  fi
  docker build -f infrastructure/openseo-patches/Dockerfile -t openseo-spaces:latest .
  docker compose -f /opt/openseo/docker-compose.yml -f /opt/openseo/docker-compose.sso.yml up -d open-seo
  printf '%s\n' "$openseo_patch_hash" > /opt/openseo/spaces-patch-revision
fi

printf '%s\n' "$remote" > "$revision_file"
