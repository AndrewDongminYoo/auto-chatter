#!/usr/bin/env bash
# cspell:words PGDATABASE PGGSSENCMODE PGHOST PGOPTIONS PGSERVICE PGSSLMODE PGTZ PGUSER pset psqlrc
set +x
set -euo pipefail

usage() {
	printf 'Usage: %s query /path/to/trusted-check.sql | cron\n' "$0" >&2
	exit 2
}

case "$#:${1:-}" in
1:cron) ;;
2:query) [[ $2 != - && -f $2 && -r $2 ]] || usage ;;
*) usage ;;
esac

if [[ -n ${PGSERVICE:-} || ! ${PGHOST:-} =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ || -z ${PGDATABASE:-} || -z ${PGUSER:-} ]]; then
	printf 'Set PGHOST to one TCP hostname and set PGDATABASE and PGUSER. Leave PGSERVICE unset.\n' >&2
	exit 2
fi

psql_bin=${PSQL17_BIN:-/opt/homebrew/opt/postgresql@17/bin/psql}
if [[ $psql_bin != /* || ! -x $psql_bin ]] ||
	! version=$("$psql_bin" --version 2>/dev/null) ||
	[[ ! $version =~ ^psql\ \(PostgreSQL\)\ 17(\.|[[:space:]]|$) ]]; then
	printf 'Set PSQL17_BIN to the absolute path of a PostgreSQL 17 psql executable.\n' >&2
	exit 2
fi

export PGSSLMODE=verify-full PGGSSENCMODE=disable PGTZ=UTC
export PGOPTIONS='-c default_transaction_read_only=on'

inspect() {
	local output
	if ! output=$("$psql_bin" --no-psqlrc --no-password --set=ON_ERROR_STOP=1 --single-transaction \
		--quiet --command='SET TRANSACTION READ ONLY' "$@" 2>/dev/null); then
		printf 'Inspection query failed. Client diagnostics are suppressed to protect connection details.\n' >&2
		return 1
	fi
	printf '%s' "$output"
}

if [[ $1 == query ]]; then
	output=$(inspect --file "$2")
	printf '%s\n' "$output"
	exit
fi

for sample in 1 2 3; do
	rows=$(inspect --no-align --tuples-only --field-separator=$'\t' --pset=null=- \
		--command='SELECT name, last_success_at, last_failure_at, failure_code, alert_active FROM public.scheduled_steps ORDER BY name')
	if [[ -z $rows ]]; then
		printf 'Cron inspection returned no rows.\n' >&2
		exit 1
	fi
	printf 'Sample %s/3 (UTC)\nname\tlast_success_at\tlast_failure_at\tfailure_code\talert_active\n%s\n' "$sample" "$rows"
	if [[ $sample != 3 ]]; then
		sleep 65
	fi
done
