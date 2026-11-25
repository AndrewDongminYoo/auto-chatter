#!/usr/bin/env bash
set -euo pipefail

prefix=${2:-dashboard-preview}
if [[ $# -lt 1 || $# -gt 2 || ! $prefix =~ ^[A-Za-z0-9_-]+$ ]]; then
	printf 'Usage: %s LOCAL_URL [SESSION_PREFIX]\n' "$0" >&2
	exit 2
fi

if ! target=$(node -e '
	const url = new URL(process.argv[1]);
	if (!["http:", "https:"].includes(url.protocol) ||
		!["localhost", "127.0.0.1"].includes(url.hostname) ||
		url.username || url.password) process.exit(2);
	console.log(url.hostname);
	console.log(url.href);
' -- "$1" 2>/dev/null); then
	printf 'Supply an HTTP or HTTPS URL on localhost or 127.0.0.1 without credentials.\n' >&2
	exit 2
fi

if ! command -v agent-browser >/dev/null; then
	printf 'Install agent-browser before checking the preview.\n' >&2
	exit 2
fi

session="$prefix-$(node -e 'console.log(require("node:crypto").randomUUID())')"
# The timeout bounds an idle daemon even if the first client is interrupted during startup.
browser=(agent-browser --idle-timeout 30s --session "$session" --allowed-domains "${target%%$'\n'*}")
active_client=
starting_client=0
interrupted=0

cleanup() {
	local result=$?
	trap - EXIT
	trap '' INT TERM
	if [[ -n $active_client ]]; then
		kill -KILL "$active_client" 2>/dev/null || true
		wait "$active_client" 2>/dev/null || true
	fi
	if ! "${browser[@]}" close >/dev/null; then
		printf 'Could not close browser session %s.\n' "$session" >&2
		if [[ $result == 0 ]]; then
			result=1
		fi
	fi
	exit "$result"
}

interrupt() {
	if ((starting_client)); then
		interrupted=$1
	else
		exit "$1"
	fi
}

run_browser() {
	local result=0
	# Defer signals until the launching client has a PID to reap.
	starting_client=1
	"${browser[@]}" "$@" &
	active_client=$!
	starting_client=0
	if ((interrupted)); then
		exit "$interrupted"
	fi
	wait "$active_client" || result=$?
	active_client=
	return "$result"
}

trap cleanup EXIT
trap 'interrupt 130' INT
trap 'interrupt 143' TERM

run_browser open "${target#*$'\n'}"
run_browser snapshot
run_browser errors
