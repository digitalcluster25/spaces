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
docker compose -f /opt/spaces/docker-compose.yml up -d
printf '%s\n' "$remote" > "$revision_file"
