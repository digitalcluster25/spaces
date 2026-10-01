#!/usr/bin/env bash
# SPC-0020: preview of branch `stage` on https://preview.spaces.community
# against the staging Supabase (/opt/spaces-staging-supabase, compose project
# "spaces-stage"). Runs from a systemd timer as root, but never executes code
# from the branch on the host: the build runs in a throwaway container as
# nobody, migrations are applied by the Supabase CLI in a container that only
# reaches the staging database. Production is not touched.
set -euo pipefail

base=/opt/spaces/preview
stage_dir=/opt/spaces-staging-supabase
repo_url=https://github.com/digitalcluster25/spaces.git
compose_file=/opt/spaces/repo/infrastructure/preview/docker-compose.yml
supabase_cli=supabase@2.90.0

install -d -m 0755 "$base" "$base/site"
exec 9>"$base/deploy.lock"
flock -n 9 || exit 0

getv() { grep -E "^$1=" "$stage_dir/.env" | head -1 | cut -d= -f2-; }
status() {
  # Public status for the agent runner: revision, ok flag, short reason. No secrets.
  python3 - "$1" "$2" "$3" > "$base/site/preview-status.json.tmp" <<'EOF'
import json, sys, datetime
print(json.dumps({"revision": sys.argv[1], "ok": sys.argv[2] == "true", "error": sys.argv[3][-3000:],
                  "updated_at": datetime.datetime.utcnow().isoformat() + "Z"}, ensure_ascii=False))
EOF
  mv "$base/site/preview-status.json.tmp" "$base/site/preview-status.json"
}

if [ ! -d "$base/repo/.git" ]; then
  git clone -q --no-checkout "$repo_url" "$base/repo"
fi
if ! git -C "$base/repo" fetch -q origin stage 2>/dev/null; then
  exit 0 # no stage branch yet
fi
remote="$(git -C "$base/repo" rev-parse FETCH_HEAD)"
deployed="$(cat "$base/deployed-revision" 2>/dev/null || true)"
[ "$remote" = "$deployed" ] && exit 0

log="$base/last-deploy.log"
: > "$log"
fail() {
  status "$remote" false "$1: $(tail -n 40 "$log")"
  echo "$remote" > "$base/deployed-revision" # do not retry the same broken revision every minute
  exit 1
}

# 1. Source tree of the revision (git archive: no .git, no hooks).
rm -rf "$base/build"
install -d -m 0755 "$base/build"
git -C "$base/repo" archive "$remote" | tar -x -C "$base/build"
chown -R 65534:65534 "$base/build"

anon="$(getv ANON_KEY)"
db_url="postgresql://postgres:$(getv POSTGRES_PASSWORD)@db:5432/postgres?sslmode=disable"

# 2. Staging DB: if it has migrations the branch does not (a rejected task), rebuild it from scratch.
applied="$(docker exec spaces-stage-db psql -U postgres -tAc "select version from supabase_migrations.schema_migrations" 2>/dev/null || true)"
wanted="$(ls "$base/build/supabase/migrations" | sed 's/_.*//')"
for version in $applied; do
  if ! grep -qx "$version" <<<"$wanted"; then
    echo "staging DB has $version which stage does not: resetting staging DB" >> "$log"
    (cd "$stage_dir" && docker compose stop >> "$log" 2>&1 && docker compose rm -f >> "$log" 2>&1 \
      && rm -rf volumes/db/data volumes/storage \
      && docker compose up -d db auth rest storage imgproxy api-gw >> "$log" 2>&1) || fail "reset staging DB"
    for i in $(seq 1 30); do
      docker exec spaces-stage-db pg_isready -U postgres >/dev/null 2>&1 && break
      sleep 5
    done
    break
  fi
done

# 3. Migrations on the staging DB only.
mig="$(mktemp -d)"
cp -r "$base/build/supabase" "$mig/"
docker run --rm --network spaces-stage_default -e PGSSLMODE=disable -e DB_URL="$db_url" \
  -v "$mig/supabase:/w/supabase" -w /w node:22-alpine \
  sh -c "npx -y $supabase_cli db push --db-url \"\$DB_URL\" --yes" >> "$log" 2>&1 || { rm -rf "$mig"; fail "migrations"; }
rm -rf "$mig"

# 4. Build as nobody in a throwaway container; only public values in the environment.
docker run --rm --user 65534:65534 --memory 2g --cpus 1.5 -e HOME=/tmp -e CI=1 \
  -e VITE_SUPABASE_URL=https://stage-supabase.spaces.community -e VITE_SUPABASE_ANON_KEY="$anon" \
  -v "$base/build:/app" -w /app node:22-alpine \
  sh -c "npm ci --no-audit --no-fund && npm run build" >> "$log" 2>&1 || fail "build"

# 5. Publish.
rsync -a --delete --exclude preview-status.json "$base/build/dist/" "$base/site/"
echo "$remote" > "$base/site/preview-revision.txt"
docker compose -f "$compose_file" up -d >> "$log" 2>&1 || fail "preview site"
status "$remote" true ""
echo "$remote" > "$base/deployed-revision"
