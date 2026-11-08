#!/usr/bin/env bash
# Decides whether the deploy workflow may deploy <commit-sha> without a manual migration first.
# It reads the active production version and its workers/tag annotation (the commit that the deploy
# workflow deployed). The guard stops when tag..sha changes db/migrations/, db/schema.sql or
# deploy/*.sql, and also when no usable tag exists (fail safe).
# MIGRATIONS_APPLIED=true (a manual run after the migration was applied by hand) proceeds in both cases.
# Exit 0: the deploy may proceed. Exit 1: stop.
# WRANGLER overrides the Wrangler command (default: corepack pnpm exec wrangler).
# It needs only bash, git and node; node parses the Wrangler JSON, so jq is not required.
set -euo pipefail

sha=${1:?usage: scripts/deploy-migration-guard.sh <commit-sha>}
for cmd in git node; do
	if ! command -v "$cmd" >/dev/null 2>&1; then
		echo "::error::Migration guard: $cmd is required and was not found on PATH."
		exit 1
	fi
done
applied=${MIGRATIONS_APPLIED:-false}
read -ra wrangler <<<"${WRANGLER:-corepack pnpm exec wrangler}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

summary() {
	if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$@" >>"$GITHUB_STEP_SUMMARY"; fi
}

# Prints the version ID of a deployment that serves one version at 100%.
# Exit 2: the file is not JSON. Exit 3: the deployment is split or names no version.
deployment_version() {
	node -e '
		const fs = require("node:fs");
		let deployment;
		try { deployment = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(2); }
		const versions = deployment?.versions;
		if (!Array.isArray(versions) || versions.length !== 1) process.exit(3);
		if (versions[0]?.percentage !== 100 || typeof versions[0]?.version_id !== "string") process.exit(3);
		process.stdout.write(versions[0].version_id);
	' "$1"
}

# Prints the workers/tag annotation of a version, or nothing. Exit 2: the file is not JSON.
version_tag() {
	node -e '
		const fs = require("node:fs");
		let version;
		try { version = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(2); }
		const tag = version?.annotations?.["workers/tag"];
		if (typeof tag === "string") process.stdout.write(tag);
	' "$1"
}

reason=""
tag=""
version_id=""
parse_status=0
if ! "${wrangler[@]}" deployments status --json --env-file /dev/null >"$tmp/deployment.json" 2>"$tmp/deployment.err"; then
	cat "$tmp/deployment.err" >&2
	reason="the active deployment could not be read"
else
	version_id=$(deployment_version "$tmp/deployment.json") || parse_status=$?
	case $parse_status in
	0) ;;
	2) reason="the active deployment output is not JSON" ;;
	3) reason="the active deployment is not one version at 100%" ;;
	*) reason="the active deployment output could not be parsed" ;;
	esac
	if [ "$parse_status" -ne 0 ]; then version_id=""; fi
fi
if [ -n "$reason" ]; then
	:
elif ! "${wrangler[@]}" versions view "$version_id" --json --env-file /dev/null >"$tmp/version.json" 2>"$tmp/version.err"; then
	cat "$tmp/version.err" >&2
	reason="version $version_id could not be read"
elif ! tag=$(version_tag "$tmp/version.json"); then
	tag=""
	reason="the output for version $version_id is not JSON"
elif [ -z "$tag" ]; then
	reason="version $version_id has no workers/tag"
elif ! [[ $tag =~ ^[0-9a-f]{40}$ ]]; then
	reason="the workers/tag of version $version_id is not a full commit SHA"
elif ! git cat-file -e "$tag^{commit}" 2>/dev/null; then
	reason="the workers/tag commit $tag is not in this repository"
elif ! git merge-base --is-ancestor "$tag" "$sha"; then
	reason="the workers/tag commit $tag is not an ancestor of $sha"
fi
echo "Active version: ${version_id:-unknown}; workers/tag: ${tag:-none}; deploy commit: $sha"

changed=""
if [ -z "$reason" ]; then
	changed=$(git diff --name-only "$tag" "$sha" -- db/migrations/ db/schema.sql 'deploy/*.sql')
	if [ -n "$changed" ]; then reason="$tag..$sha changes the database schema or access scripts"; fi
fi

if [ -z "$reason" ]; then
	echo "Migration guard: no database change since the active version."
	exit 0
fi

if [ "$applied" = true ]; then
	echo "::notice::Migration guard: $reason; proceeding because migrations_applied is true."
	summary "Migration guard: $reason; proceeding because \`migrations_applied\` is true."
	exit 0
fi

echo "::error::Migration guard stopped the deploy: $reason."
if [ -n "$changed" ]; then printf 'Changed: %s\n' "$changed"; fi
summary "## Deploy stopped by the migration guard" "" "Reason: $reason." ""
if [ -n "$changed" ]; then
	summary "Changed database files:" ""
	while IFS= read -r file; do summary "- \`$file\`"; done <<<"$changed"
	summary ""
fi
summary "Apply the migration by hand first (administrator connection, backup, deploy/migrate-multi-user.sql), as described in docs/notes/2026-09-26-cloudflare-runbook.md." \
	"Then run the Deploy workflow manually on main with migrations_applied: true."
exit 1
