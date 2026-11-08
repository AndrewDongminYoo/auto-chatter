#!/usr/bin/env bash
# Read-only public smoke check of a deployed Worker: public pages, refused webhook and API
# requests, and the SHA-256 of every public/app/ file compared with the body served at /app/.
# It sends no message and needs no credential.
# Usage: scripts/production-smoke.sh [base-url]   (default https://auto-chat.donminzzi.kr)
set -uo pipefail

base=${1:-https://auto-chat.donminzzi.kr}
base=${base%/}
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
pass=0
fail=0

check() {
	if [ "$2" = "$3" ]; then
		pass=$((pass + 1))
	else
		fail=$((fail + 1))
		echo "FAIL $1: expected $2, got $3"
	fi
}

code() {
	curl -sS -o /dev/null --max-time 15 -w '%{http_code}' "$@" 2>/dev/null
}

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum | cut -d' ' -f1
	else
		shasum -a 256 | cut -d' ' -f1
	fi
}

for page in /privacy /data-deletion /service; do
	check "GET $page" 200 "$(code "$base$page")"
done
check "GET webhook wrong verify token" 403 "$(code "$base/webhooks/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1")"
check "POST webhook unsigned" 403 "$(code -X POST -H 'content-type: application/json' --data '{}' "$base/webhooks/instagram")"
check "POST /api/workspace cross-origin" 403 "$(code -X POST -H 'origin: https://example.com' -H 'content-type: application/json' --data '{}' "$base/api/workspace")"
check "GET /api/inbox without session" 401 "$(code "$base/api/inbox")"

hashed=0
for file in "$repo"/public/app/*; do
	[ -f "$file" ] || continue
	name=$(basename "$file")
	url="$base/app/$name"
	# /app/index.html redirects with an empty body; the page itself is served at /app/.
	if [ "$name" = index.html ]; then url="$base/app/"; fi
	expected=$(sha256 <"$file")
	actual=$(curl -sS --fail --max-time 15 "$url" 2>/dev/null | sha256)
	check "hash /app/$name" "$expected" "$actual"
	hashed=$((hashed + 1))
done
check "files hashed in public/app/" nonzero "$([ "$hashed" -gt 0 ] && echo nonzero || echo 0)"

echo "base=$base pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
