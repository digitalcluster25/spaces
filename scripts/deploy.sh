#!/usr/bin/env bash
set -Eeuo pipefail

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

# SPC-0020: release status for the agent runner (read-only mount), and production
# migrations applied here — the only place that holds production DB credentials.
release_dir="/opt/spaces/release-status"
failed_file="/opt/spaces/failed-revision"
install -d -m 0755 "$release_dir"
release_stage="idle"
release_backup=""
release_status() {
  python3 - "$1" "$2" "$3" "$4" "$release_backup" > "$release_dir/status.json.tmp" <<'PY'
import json, sys, datetime
print(json.dumps({"revision": sys.argv[1], "ok": sys.argv[2] == "true", "stage": sys.argv[3],
                  "error": sys.argv[4][-2000:], "backup": sys.argv[5],
                  "updated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}, ensure_ascii=False))
PY
  mv "$release_dir/status.json.tmp" "$release_dir/status.json"
}
on_release_error() {
  local code=$?
  case "$release_stage" in
    idle|done) ;;
    backup|migrations)
      # Never retry a failed backup/migration every minute: wait for a new commit.
      release_status "$remote" false "$release_stage" "exit $code"
      printf '%s\n' "$remote" > "$failed_file" ;;
    *) release_status "$remote" false "$release_stage" "exit $code" ;;
  esac
}
trap on_release_error ERR

apply_production_migrations() {
  local envfile applied pending version
  envfile="$(mktemp)"
  chmod 600 "$envfile"
  # operations.env is not shell-safe (values with spaces): read keys, never source it.
  python3 - /opt/spaces/operations.env > "$envfile" <<'PY'
import sys, urllib.parse as u
env = {}
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.rstrip("\n")
    if "=" in line and not line.lstrip().startswith("#"):
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip().strip('"').strip("'")
h, p, user, db, pw = (env[k] for k in ("SUPABASE_DB_HOST", "SUPABASE_DB_PORT", "SUPABASE_DB_USER", "SUPABASE_DB_NAME", "SUPABASE_DB_PASSWORD"))
print(f"PGHOST={h}\nPGPORT={p}\nPGUSER={user}\nPGDATABASE={db}\nPGPASSWORD={pw}")
print(f"DB_URL=postgresql://{u.quote(user, safe='')}:{u.quote(pw, safe='')}@{h}:{p}/{db}")
PY
  applied="$(docker run --rm --env-file "$envfile" postgres:17-alpine psql -tAc "select version from supabase_migrations.schema_migrations")"
  pending=""
  for version in $(ls "$repo_dir/supabase/migrations" | sed 's/_.*//'); do
    grep -qx "$version" <<<"$applied" || pending="$pending $version"
  done
  if [ -n "$pending" ]; then
    release_stage="backup"
    systemctl start spaces-backup.service
    release_backup="$( (ls -t /opt/spaces/backups/*.spcbak 2>/dev/null || true) | head -1 | xargs -r basename)"
    release_stage="migrations"
    local work
    work="$(mktemp -d)"
    cp -r "$repo_dir/supabase" "$work/"
    docker run --rm --env-file "$envfile" -v "$work/supabase:/w/supabase" -w /w node:22-alpine \
      sh -c 'npx -y supabase@2.90.0 db push --db-url "$DB_URL" --yes'
    rm -rf "$work"
  fi
  rm -f "$envfile"
}

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
install -d -m 0700 /opt/spaces/backups
if [ ! -f /opt/spaces/tasks-sso.env ]; then
  install -m 0600 /dev/null /opt/spaces/tasks-sso.env
fi

if { [ "$deployed" != "$remote" ] || [ ! -f "$site_dir/index.html" ]; } && [ "$remote" != "$(cat "$failed_file" 2>/dev/null || true)" ]; then
  git reset --hard origin/main
  release_stage="migrations-check"
  apply_production_migrations
  release_stage="build"
  if [ ! -d node_modules ]; then
    npm ci --no-audit --no-fund
  fi
  npm run build
  release_stage="publish"
  rsync -a --delete dist/ "$site_dir/"
  install -m 0644 infrastructure/spaces-site/docker-compose.yml /opt/spaces/docker-compose.yml
  install -m 0644 infrastructure/spaces-site/nginx.conf /opt/spaces/nginx.conf
  docker compose -f /opt/spaces/docker-compose.yml up -d --force-recreate
  release_stage="done"
  release_status "$remote" true "done" ""
fi
release_stage="done"

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
