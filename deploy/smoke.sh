#!/usr/bin/env bash
# Does `docker compose up -d` give a working installation? Builds the image from this checkout
# as agentome:smoke, not compose.override.yaml's agentome:local, which an installation on this
# machine may be running. Starts it as the project agentome-smoke without the checkout's .env,
# so that a real installation is never touched, checks what a first visit needs plus a backup
# and a restore, and removes the project with its volumes on exit.
#
#   deploy/smoke.sh                            # on port 3000
#   AGENTOME_HTTP_PORT=3100 deploy/smoke.sh    # when 3000 is taken
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
export AGENTOME_HTTP_PORT="${AGENTOME_HTTP_PORT:-3000}"
base="http://127.0.0.1:$AGENTOME_HTTP_PORT"
work="$(mktemp -d)"
started=$(date +%s)

printf 'services:\n  app:\n    image: agentome:smoke\n' >"$work/smoke.yaml"

compose() {
  docker compose -f "$root/compose.yaml" -f "$root/compose.override.yaml" -f "$work/smoke.yaml" \
    --env-file /dev/null -p agentome-smoke "$@"
}
fail() {
  echo "FAIL: $*" >&2
  exit 1
}
finish() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo '--- docker compose logs app' >&2
    compose logs --no-color --tail 100 app >&2 || true
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap finish EXIT

# GET $1 with the headers that follow; the status, then the body in $work/body.
get() {
  local path="$1"
  shift
  curl -sS -o "$work/body" -w '%{http_code}' "$@" "$base$path"
}

compose down -v --remove-orphans >/dev/null 2>&1 || true
compose up -d --build --wait --wait-timeout 120 || fail 'the installation did not become healthy'
echo "ok  healthy after $(($(date +%s) - started)) s"
for path in /health /ready; do
  [ "$(get "$path")" = 200 ] || fail "GET $path answered $(cat "$work/body")"
  echo "ok  GET $path"
done

[ "$(get / -H 'Accept: text/html')" = 200 ] || fail 'GET / did not answer 200'
grep -q '<div id="root">' "$work/body" || fail 'GET / is not the web app'
echo 'ok  GET / is the web app'
asset="$(grep -o '/assets/[^"]*\.js' "$work/body" | head -n 1 || true)"
[ -n "$asset" ] || fail 'index.html names no script in /assets'
cache="$(curl -fsS -o /dev/null -w '%header{cache-control}' "$base$asset")" || fail "GET $asset"
[ "$cache" = 'public, max-age=31536000, immutable' ] || fail "GET $asset is cached as '$cache'"
echo "ok  GET $asset"

# Misses stay JSON: an unknown API route, and a probe off by a slash.
for path in /api/nope /ready/; do
  [ "$(get "$path")" = 404 ] || fail "GET $path did not answer 404"
  grep -q '"code":"not_found"' "$work/body" || fail "GET $path is not the JSON 404"
  echo "ok  GET $path is a JSON 404"
done

# The one-line install of a seat: the script names the checksum of the worker it hands out, and
# that worker runs on the image's own Node.
[ "$(get /connect)" = 200 ] || fail 'GET /connect did not answer 200'
sha="$(sed -n "s/^sha256='\([0-9a-f]\{64\}\)'$/\1/p" "$work/body")"
[ -n "$sha" ] || fail 'the /connect script names no checksum'
[ "$(get /connect/agentome-worker.mjs)" = 200 ] || fail 'GET /connect/agentome-worker.mjs failed'
got="$( (sha256sum 2>/dev/null || shasum -a 256) <"$work/body" | cut -d' ' -f1)"
[ "$got" = "$sha" ] || fail "the worker's checksum is $got, the script says $sha"
compose exec -T app node dist/connect/agentome-worker.mjs help | grep -q '^Usage: agentome-worker' ||
  fail 'the bundled worker does not run'
echo 'ok  GET /connect and the worker it checks'

compose exec -T app agentome backup >"$work/backup.tar.gz" || fail 'agentome backup failed'
listing="$(tar -tzf "$work/backup.tar.gz")"
grep -qx 'db.dump' <<<"$listing" || fail 'the backup has no db.dump'
grep -qx 'data/secrets/secret.key' <<<"$listing" || fail 'the backup has no secret key'
compose exec -T app agentome restore <"$work/backup.tar.gz" || fail 'agentome restore failed'
[ "$(get /ready)" = 200 ] || fail 'GET /ready failed after the restore'
echo 'ok  agentome backup and agentome restore'

# The one command that loads the server's own modules: it has to get as far as looking the
# account up, which a CLI that cannot find them never does.
out="$(compose exec -T app agentome reset-password nobody@example.com 2>&1 || true)"
grep -q 'No account with the email nobody@example.com' <<<"$out" ||
  fail "agentome reset-password does not run: $out"
echo 'ok  agentome reset-password reaches the database'

echo "PASS in $(($(date +%s) - started)) s"
