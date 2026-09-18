#!/usr/bin/env bash
# Smoke test of the deployable artifact: the Docker image exactly as the hosting runs it.
#   1. starts on a named volume and becomes healthy; the app process runs as the unprivileged "node" user;
#   2. security and cache headers are in place;
#   3. synthetic traffic from the generator matches the dashboard (--verify);
#   4. a graceful stop (SIGTERM, like a deploy) exits cleanly and fast;
#   5. after a restart on the same volume nothing is lost.
# Usage: scripts/docker-smoke.sh [image]   (without an image argument the image is built from the Dockerfile)
set -euo pipefail

IMAGE="${1:-}"
NAME="funnel-smoke-$$"
VOLUME="funnel-smoke-data-$$"
PORT="${SMOKE_PORT:-18080}"
URL="http://localhost:${PORT}"
export ADMIN_TOKEN="smoke-admin-token-0123456789"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() { echo "SMOKE FAILED: $*" >&2; docker logs "$NAME" 2>&1 | tail -30 >&2 || true; exit 1; }

wait_healthy() {
  for _ in $(seq 1 60); do
    if curl -fsS "$URL/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "not healthy within 60 s"
}

started_total() {
  curl -fsS -H "x-admin-token: $ADMIN_TOKEN" "$URL/api/analytics?funnelId=workstyle-planner&in_progress_minutes=0" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.versions.reduce((n,v)=>n+v.started,0))})'
}

if [ -z "$IMAGE" ]; then
  IMAGE="funnel-runtime:smoke"
  docker build -t "$IMAGE" .
fi

echo "1. start on a fresh volume"
docker run -d --name "$NAME" -p "$PORT:8080" -v "$VOLUME:/data" -e ADMIN_TOKEN "$IMAGE" >/dev/null
wait_healthy
uid=$(docker exec "$NAME" sh -c 'grep "^Uid:" /proc/1/status | cut -f2')
[ "$uid" = "1000" ] || fail "app runs as uid $uid, expected 1000 (node)"
echo "   healthy, app runs as uid $uid"

echo "2. headers"
page_headers=$(curl -fsSI "$URL/f/workstyle-planner")
echo "$page_headers" | grep -qi '^content-security-policy:' || fail "no Content-Security-Policy"
echo "$page_headers" | grep -qi '^x-content-type-options: nosniff' || fail "no nosniff"
echo "$page_headers" | grep -qi '^cache-control: no-cache' || fail "index.html must not be cached"
asset=$(curl -fsS "$URL/f/workstyle-planner" | grep -o '/assets/index-[^"]*\.js' | head -1)
curl -fsSI "$URL$asset" | grep -qi 'immutable' || fail "hashed assets must be immutable"
echo "   CSP, nosniff, no-cache page, immutable assets"

echo "3. traffic --verify against the container"
npm run -s traffic -- --url "$URL" --sessions 60 --verify >/tmp/smoke-traffic.log 2>&1 || { tail -40 /tmp/smoke-traffic.log; fail "traffic --verify"; }
before=$(started_total)
echo "   dashboard matches the generator; started sessions: $before"

echo "4. graceful stop (SIGTERM)"
t0=$(date +%s)
docker stop -t 20 "$NAME" >/dev/null
elapsed=$(( $(date +%s) - t0 ))
code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
[ "$code" = "0" ] || fail "exit code $code after SIGTERM (expected a clean shutdown)"
[ "$elapsed" -lt 15 ] || fail "shutdown took ${elapsed}s"
echo "   exited 0 in ${elapsed}s"

echo "5. restart on the same volume"
docker start "$NAME" >/dev/null
wait_healthy
after=$(started_total)
[ "$after" = "$before" ] || fail "data lost across restart: $before -> $after"
echo "   still $after sessions after restart"

echo "SMOKE OK"
