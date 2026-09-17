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

if [ "$deployed" != "$remote" ] || [ ! -f "$site_dir/index.html" ]; then
  git reset --hard origin/main
  if [ ! -d node_modules ]; then
    npm ci --no-audit --no-fund
  fi
  npm run build
  rsync -a --delete dist/ "$site_dir/"
  if [ ! -f /opt/spaces/data-plane.env ]; then
    install -m 0600 /dev/null /opt/spaces/data-plane.env
    grep -E '^(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)=' /opt/spaces/provisioner.env >> /opt/spaces/data-plane.env
    printf 'SPACES_DATA_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" >> /opt/spaces/data-plane.env
    printf 'DATA_PLANE_INTERNAL_SECRET=%s\n' "$(openssl rand -hex 32)" >> /opt/spaces/data-plane.env
  fi
  grep -q '^DATA_DISTRIBUTED_RATE_LIMIT=' /opt/spaces/data-plane.env || printf 'DATA_DISTRIBUTED_RATE_LIMIT=true\n' >> /opt/spaces/data-plane.env
  grep -q '^MCP_DISTRIBUTED_RATE_LIMIT=' /opt/spaces/mcp-gateway.env || printf 'MCP_DISTRIBUTED_RATE_LIMIT=true\n' >> /opt/spaces/mcp-gateway.env
  if [ ! -f /opt/spaces/operations.env ]; then
    install -m 0600 /dev/null /opt/spaces/operations.env
    grep -E '^(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)=' /opt/spaces/provisioner.env >> /opt/spaces/operations.env
    printf 'SPACES_BACKUP_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" >> /opt/spaces/operations.env
    printf '%s\n' \
      'SUPABASE_DB_HOST=aws-0-eu-west-3.pooler.supabase.com' \
      'SUPABASE_DB_PORT=5432' \
      'SUPABASE_DB_USER=postgres.fnrzqmecumyagcajivsu' \
      'SUPABASE_DB_NAME=postgres' \
      'BACKUP_DIRECTORY=/opt/spaces/backups' \
      'BACKUP_RETENTION_DAYS=14' \
      'ALERT_EMAIL=digitalcluster25@gmail.com' \
      'ALERT_FROM=no-reply@spaces.community' \
      'ALERT_SENDER_NAME=Spaces Operations' >> /opt/spaces/operations.env
  fi
  install -m 0644 infrastructure/spaces-site/docker-compose.yml /opt/spaces/docker-compose.yml
  install -m 0644 infrastructure/spaces-site/nginx.conf /opt/spaces/nginx.conf
  docker compose -f /opt/spaces/docker-compose.yml up -d --force-recreate
fi

install -m 0644 infrastructure/operations/spaces-monitor.service /etc/systemd/system/spaces-monitor.service
install -m 0644 infrastructure/operations/spaces-monitor.timer /etc/systemd/system/spaces-monitor.timer
install -m 0644 infrastructure/operations/spaces-backup.service /etc/systemd/system/spaces-backup.service
install -m 0644 infrastructure/operations/spaces-backup.timer /etc/systemd/system/spaces-backup.timer
systemctl daemon-reload
systemctl enable --now spaces-monitor.timer spaces-backup.timer >/dev/null

install -m 0755 scripts/deploy.sh /opt/spaces/bin/deploy.sh

outline_hash="$(sha256sum infrastructure/outline-spaces-sso/server.js infrastructure/outline-spaces-sso/memory-adapter.js infrastructure/outline-spaces-sso/package.json infrastructure/outline-spaces-sso/docker-compose.override.yml infrastructure/outline-spaces-sso/nginx.conf infrastructure/outline-spaces-sso/spaces-shell.css infrastructure/outline-spaces-sso/spaces-shell.js infrastructure/shared/tenant-panel.js | sha256sum | cut -d' ' -f1)"
if [ "$(cat /opt/outline/spaces-sso-revision 2>/dev/null || true)" != "$outline_hash" ]; then
  install -d -m 0755 /opt/outline/spaces-shell
  install -m 0644 infrastructure/outline-spaces-sso/server.js /opt/outline/spaces-sso/server.js
  install -m 0644 infrastructure/outline-spaces-sso/memory-adapter.js /opt/outline/spaces-sso/memory-adapter.js
  install -m 0644 infrastructure/outline-spaces-sso/package.json /opt/outline/spaces-sso/package.json
  install -m 0644 infrastructure/outline-spaces-sso/docker-compose.override.yml /opt/outline/docker-compose.override.yml
  install -m 0644 infrastructure/outline-spaces-sso/nginx.conf /opt/outline/spaces-shell/nginx.conf
  install -m 0644 infrastructure/outline-spaces-sso/spaces-shell.css /opt/outline/spaces-shell/spaces-shell.css
  install -m 0644 infrastructure/outline-spaces-sso/spaces-shell.js /opt/outline/spaces-shell/spaces-shell.js
  docker compose -f /opt/outline/docker-compose.yml -f /opt/outline/docker-compose.override.yml up -d --force-recreate outline spaces-sso spaces-shell
  printf '%s\n' "$outline_hash" > /opt/outline/spaces-sso-revision
fi

openseo_sso_hash="$(sha256sum infrastructure/openseo-spaces-sso/server.js infrastructure/openseo-spaces-sso/docker-compose.sso.yml infrastructure/shared/tenant-panel.js | sha256sum | cut -d' ' -f1)"
if [ "$(cat /opt/openseo/spaces-sso-revision 2>/dev/null || true)" != "$openseo_sso_hash" ]; then
  install -m 0644 infrastructure/openseo-spaces-sso/server.js /opt/openseo/spaces-sso/server.js
  install -m 0644 infrastructure/openseo-spaces-sso/docker-compose.sso.yml /opt/openseo/docker-compose.sso.yml
  docker compose -f /opt/openseo/docker-compose.yml -f /opt/openseo/docker-compose.sso.yml up -d --force-recreate spaces-sso open-seo
  printf '%s\n' "$openseo_sso_hash" > /opt/openseo/spaces-sso-revision
fi

if ! docker inspect openseo --format '{{json (index .NetworkSettings.Networks "openseo_default").Aliases}}' | grep -q 'openseo.spaces.community'; then
  docker compose -f /opt/openseo/docker-compose.yml -f /opt/openseo/docker-compose.sso.yml up -d --force-recreate open-seo
fi

openseo_patch_hash="$(find infrastructure/openseo-patches -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"
if [ "$(cat /opt/openseo/spaces-patch-revision 2>/dev/null || true)" != "$openseo_patch_hash" ]; then
  if ! docker image inspect openseo-spaces:base-20260912 >/dev/null 2>&1; then
    docker tag openseo-spaces:latest openseo-spaces:base-20260912
  fi
  docker build --secret id=openseo_env,src=/opt/openseo/.env -f infrastructure/openseo-patches/Dockerfile -t openseo-spaces:latest .
  docker compose -f /opt/openseo/docker-compose.yml -f /opt/openseo/docker-compose.sso.yml up -d open-seo
  printf '%s\n' "$openseo_patch_hash" > /opt/openseo/spaces-patch-revision
fi

printf '%s\n' "$remote" > "$revision_file"
