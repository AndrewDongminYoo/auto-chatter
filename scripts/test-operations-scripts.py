"""Verify the operations scripts through isolated CLI stand-ins."""

# cspell:words PGDATABASE PGGSSENCMODE PGHOST PGOPTIONS PGSERVICE PGSSLMODE PGTZ PGUSER psqlrc
import os
import re
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
PASSWORD = "do-not-print-fixture-password"


class OperationsScriptsTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        self.trace = directory / "trace"
        self.client_pid = directory / "client-pid"
        self.sql = directory / "preflight.sql"
        self.sql.write_text("SELECT 1;\n", encoding="utf-8")
        self.env = {
            "PATH": f"{directory}:{os.environ['PATH']}",
            "PSQL17_BIN": str(directory / "psql"),
            "PGHOST": "production.example",
            "PGDATABASE": "postgres",
            "PGUSER": "postgres.fixture",
            "PGPASSWORD": PASSWORD,
            "PGSSLMODE": "disable",
            "MOCK_TRACE": str(self.trace),
            "MOCK_CLIENT_PID": str(self.client_pid),
        }
        mocks = {
            "psql": r"""
if [[ $1 == --version ]]; then
  printf 'psql (PostgreSQL) %s\n' "$MOCK_PSQL_VERSION"
  exit 0
fi
printf '%s | %s | %s | %s | %s\n' "$PGSSLMODE" "$PGGSSENCMODE" "$PGOPTIONS" "$PGTZ" "$*" >> "$MOCK_TRACE"
case "$MOCK_MODE" in
  empty) exit 0 ;;
  fail) printf '%s\n' "$PGPASSWORD" >&2; exit 2 ;;
esac
printf 'cron\t2026-11-25 12:00:00+00\t-\t-\tf\n'
""",
            "sleep": r"""printf '%s\n' "sleep $*" >> "$MOCK_TRACE" """,
            "agent-browser": r"""
printf '%s\n' "$*" >> "$MOCK_TRACE"
case "$MOCK_MODE:$*" in
  hang-open:*" open "*|hang-snapshot:*" snapshot")
    printf '%s\n' "$$" > "$MOCK_CLIENT_PID"
    exec /bin/sleep 10 ;;
esac
case "$*" in
  *" open "*) [[ $MOCK_MODE != open-fail ]] ;;
  *" snapshot")
    case "$MOCK_MODE" in
      INT|TERM) kill -s "$MOCK_MODE" "$PPID" ;;
      snapshot-fail) exit 7 ;;
    esac ;;
  *" close")
    if [[ -s $MOCK_CLIENT_PID ]] && kill -0 "$(< "$MOCK_CLIENT_PID")" 2>/dev/null; then
      printf 'Client still running at close\n' >&2
      exit 9
    fi
    [[ $MOCK_MODE != close-fail ]] ;;
esac
""",
        }
        for name, contents in mocks.items():
            executable = directory / name
            executable.write_text(
                f"#!/bin/bash\n{contents.strip()}\n", encoding="utf-8"
            )
            executable.chmod(0o700)

    def run_script(self, script, *args, bash_flags=(), **overrides):
        self.trace.write_text("", encoding="utf-8")
        result = subprocess.run(
            ["bash", *bash_flags, SCRIPTS / script, *args],
            cwd=self.sql.parent,
            env={"MOCK_PSQL_VERSION": "17.7", **self.env, **overrides},
            text=True,
            capture_output=True,
            check=False,
            timeout=10,
        )
        return result, self.trace.read_text(encoding="utf-8")

    def test_query_uses_verified_tls_and_a_read_only_transaction(self):
        result, trace = self.run_script("inspect-production.sh", "query", self.sql)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(
            "verify-full | disable | -c default_transaction_read_only=on | UTC |", trace
        )
        self.assertIn(
            "--no-psqlrc --no-password --set=ON_ERROR_STOP=1 --single-transaction",
            trace,
        )
        self.assertIn("SET TRANSACTION READ ONLY", trace)
        self.assertIn(str(self.sql), trace)
        self.assertNotIn(PASSWORD, trace)

    def test_cron_samples_current_columns_and_rejects_empty_or_failed_queries(self):
        result, trace = self.run_script("inspect-production.sh", "cron")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.count("2026-11-25 12:00:00+00"), 3)
        query = "SELECT name, last_success_at, last_failure_at, failure_code, alert_active FROM public.scheduled_steps"
        self.assertEqual(trace.count(query), 3)
        self.assertEqual(trace.count("sleep 65"), 2)
        for mode, message in [("empty", "no rows"), ("fail", "query failed")]:
            with self.subTest(mode=mode):
                result, trace = self.run_script(
                    "inspect-production.sh", "cron", MOCK_MODE=mode
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr.lower())
                self.assertNotIn(PASSWORD, result.stderr + result.stdout + trace)

    def test_query_rejects_psql_standard_input_marker_even_if_file_exists(self):
        self.sql.with_name("-").write_text("SELECT 1;\n", encoding="utf-8")
        result, trace = self.run_script("inspect-production.sh", "query", "-")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(trace, "")

    def test_inspection_does_not_trace_connection_settings(self):
        result, trace = self.run_script(
            "inspect-production.sh",
            "cron",
            bash_flags=("-x",),
            PGHOST="fixture-host.example",
            PGDATABASE="fixture-database",
            PGUSER="fixture-user",
            PSQL17_BIN=str(self.sql.parent / "missing-psql"),
        )
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("fixture-", result.stderr)
        self.assertNotIn("missing-psql", result.stderr)
        self.assertEqual(trace, "")

    def test_connection_rejects_service_override_socket_or_wrong_client(self):
        for override in [
            {"PGSERVICE": "unsafe"},
            {"PGHOST": "/tmp"},
            {"MOCK_PSQL_VERSION": "19.1"},
        ]:
            with self.subTest(override=override):
                result, trace = self.run_script(
                    "inspect-production.sh", "cron", **override
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(trace, "")

    def test_preview_closes_only_its_session_on_success_failure_and_signals(self):
        cases = [
            ("normal", 0),
            ("open-fail", 1),
            ("snapshot-fail", 7),
            ("close-fail", 1),
            ("INT", 130),
            ("TERM", 143),
        ]
        for mode, status in cases:
            with self.subTest(mode=mode):
                result, trace = self.run_script(
                    "check-preview.sh",
                    "http://127.0.0.1:4173/app/",
                    "fixture",
                    MOCK_MODE=mode,
                )
                self.assertEqual(result.returncode, status, result.stderr)
                commands = trace.splitlines()
                session = re.search(r"--session (fixture-[a-f0-9-]+)", commands[0])
                self.assertIsNotNone(session)
                self.assertTrue(
                    all(f"--session {session[1]} " in command for command in commands)
                )
                self.assertEqual(
                    sum(command.endswith(" close") for command in commands), 1
                )
                self.assertTrue(commands[-1].endswith(" close"))
                self.assertIn(
                    "--allowed-domains 127.0.0.1 open http://127.0.0.1:4173/app/",
                    commands[0],
                )

    def test_preview_rejects_non_loopback_urls_and_credentials(self):
        for url in [
            "https://example.com",
            "http://localhost.example.com",
            f"http://fixture:{PASSWORD}@localhost",
            "file:///tmp/test",
        ]:
            with self.subTest(url=url):
                result, trace = self.run_script("check-preview.sh", url)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(trace, "")

    def test_preview_interrupts_a_hung_client_before_closing_its_session(self):
        for mode, interrupt, status in [
            ("hang-open", signal.SIGINT, 130),
            ("hang-open", signal.SIGTERM, 143),
            ("hang-snapshot", signal.SIGINT, 130),
            ("hang-snapshot", signal.SIGTERM, 143),
        ]:
            with self.subTest(mode=mode, interrupt=interrupt):
                self.trace.write_text("", encoding="utf-8")
                self.client_pid.unlink(missing_ok=True)
                command = [
                    "bash",
                    SCRIPTS / "check-preview.sh",
                    "http://localhost:4173/app/",
                ]
                with subprocess.Popen(
                    command,
                    env={**self.env, "MOCK_MODE": mode},
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                ) as process:
                    deadline = time.monotonic() + 3
                    while not self.client_pid.exists() and time.monotonic() < deadline:
                        time.sleep(0.02)
                    try:
                        child = int(self.client_pid.read_text(encoding="utf-8"))
                        process.send_signal(interrupt)
                        _, errors = process.communicate(timeout=2)
                        self.assertEqual(process.returncode, status, errors)
                        self.assertNotIn("Client still running", errors)
                        with self.assertRaises(ProcessLookupError):
                            os.kill(child, 0)
                        commands = self.trace.read_text(encoding="utf-8").splitlines()
                        self.assertEqual(
                            sum(line.endswith(" close") for line in commands), 1
                        )
                        prefix = commands[0].split(" open ")[0]
                        self.assertEqual(commands[-1], f"{prefix} close")
                    finally:
                        if process.poll() is None:
                            process.kill()
                            if self.client_pid.exists():
                                try:
                                    os.kill(
                                        int(
                                            self.client_pid.read_text(encoding="utf-8")
                                        ),
                                        signal.SIGKILL,
                                    )
                                except ProcessLookupError:
                                    pass


if __name__ == "__main__":
    unittest.main()
