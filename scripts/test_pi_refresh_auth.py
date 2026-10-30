"""Offline tests: python -m unittest discover -s scripts -p test_pi_refresh_auth.py"""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("pi-refresh-auth.py")
SPEC = importlib.util.spec_from_file_location("pi_refresh_auth", SCRIPT)
REFRESH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REFRESH)

FAKE_CLI = '''import json
import os
from pathlib import Path
import sys
import time

provider = sys.argv[sys.argv.index("--provider") + 1]
with open(os.environ["FAKE_PI_LOG"], "a", encoding="utf-8") as log:
    log.write(json.dumps({"args": sys.argv[1:], "agent_dir": os.environ["PI_CODING_AGENT_DIR"],
                          "cwd": os.getcwd()}) + "\\n")
if provider == "slow":
    time.sleep(30)
print("SECRET-CHILD-OUTPUT", file=sys.stderr)
code = 2 if provider == "invalid" else 1 if provider == "not-ready" else 0
result = {"provider": provider, "status": "ready"}
if provider == "invalid":
    result.update(status="invalid", reason="invalid_state")
elif provider == "not-ready":
    result.update(status="not_ready", reason="credentials_not_configured")
elif provider in ("google-gemini-cli", "jetbrains", "xai-oauth"):
    result.update(status="not_ready", reason="provider_not_found")
    code = 1
sys.stdout.write("SECRET" * 12_000 if os.environ.get("FAKE_PI_OVERSIZED") else
                 os.environ.get("FAKE_PI_RESPONSE", json.dumps(result)))
sys.exit(int(os.environ.get("FAKE_PI_EXIT", code)))
'''


class RefreshAuthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.agent_dir = self.root / "agent config"
        self.agent_dir.mkdir()
        self.auth_path = self.agent_dir / "auth.json"
        self.log_path = self.root / "calls.jsonl"
        # Exercise Windows command quoting, including literal env expansion text.
        self.bin_dir = self.root / "bin space & (test) ! %PATH%"
        self.bin_dir.mkdir()
        if os.name == "nt":
            self.pi = self.bin_dir / "pi.cmd"
            (self.bin_dir / "fake_cli.py").write_text(FAKE_CLI, encoding="utf-8")
            self.pi.write_text(
                '@echo off\n"' + sys.executable + '" "%~dp0fake_cli.py" %*\n',
                encoding="utf-8",
            )
        else:
            self.pi = self.bin_dir / "pi"
            self.pi.write_text("#!" + sys.executable + "\n" + FAKE_CLI, encoding="utf-8")
            self.pi.chmod(0o755)
        self.env = os.environ.copy()
        self.env["FAKE_PI_LOG"] = str(self.log_path)
        self.env["PI_CODING_AGENT_DIR"] = str(self.root / "wrong-agent-dir")
        self.write_auth({"openai-codex": {"type": "oauth", "refresh": "SECRET-TOKEN"}})

    def write_auth(self, auth):
        self.auth_path.write_text(json.dumps(auth), encoding="utf-8")

    def run_script(self, *args, explicit_pi=True, explicit_agent_dir=True):
        command = [sys.executable, str(SCRIPT)]
        if explicit_pi:
            command.extend(["--pi", str(self.pi)])
        if explicit_agent_dir:
            command.extend(["--agent-dir", str(self.agent_dir)])
        return subprocess.run(
            command + list(args), env=self.env, capture_output=True, text=True, timeout=15,
        )

    def calls(self):
        if not self.log_path.exists():
            return []
        return [json.loads(line) for line in self.log_path.read_text(encoding="utf-8").splitlines()]

    def test_checks_only_oauth_and_preserves_auth_file(self):
        self.write_auth({
            "openai-codex": {"type": "oauth", "refresh": "SECRET-TOKEN"},
            "github-copilot": {"type": "oauth"},
            "openai": {"type": "api_key", "key": "SECRET-KEY"},
            "other": None,
        })
        original = self.auth_path.read_bytes()
        result = self.run_script("--verbose")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertEqual([call["args"] for call in calls], [
            ["auth", "check", "--provider", "openai-codex", "--json"],
            ["auth", "check", "--provider", "github-copilot", "--json"],
        ])
        for call in calls:
            self.assertEqual(Path(call["agent_dir"]), self.agent_dir)
            self.assertEqual(Path(call["cwd"]), self.agent_dir)
        self.assertEqual(self.auth_path.read_bytes(), original)
        self.assertIn("openai-codex: ready", result.stderr)
        self.assertNotIn("SECRET", result.stdout + result.stderr)

    def test_success_is_quiet(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout + result.stderr, "")

    def test_continues_after_provider_failures(self):
        self.write_auth({name: {"type": "oauth"} for name in ["invalid", "not-ready", "openai-codex"]})
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(self.calls()), 3)
        self.assertIn("invalid (exit 2; reason: invalid_state)", result.stderr)
        self.assertIn("not_ready (exit 1; reason: credentials_not_configured)", result.stderr)
        self.assertNotIn("SECRET", result.stdout + result.stderr)

    def test_unknown_providers_are_skipped_without_modifying_credentials(self):
        self.write_auth({name: {"type": "oauth"} for name in [
            "google-gemini-cli", "jetbrains", "xai-oauth", "openai-codex",
        ]})
        original = self.auth_path.read_bytes()
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout + result.stderr, "")
        self.assertEqual(len(self.calls()), 4)
        self.assertEqual(self.auth_path.read_bytes(), original)
        result = self.run_script("--verbose")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr.count("skipped (provider not recognized"), 3)
        self.assertIn("openai-codex: ready", result.stderr)

    def test_unknown_provider_does_not_hide_other_failures(self):
        self.write_auth({"jetbrains": {"type": "oauth"}, "invalid": {"type": "oauth"}})
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertIn("invalid_state", result.stderr)
        self.assertNotIn("jetbrains", result.stderr)

    def test_invalid_cli_responses_are_errors_without_leaking_contents(self):
        for payload in [
            "SECRET-CHILD-OUTPUT", "[]", "SECRET" * 12_000,
            json.dumps({"provider": "wrong", "status": "ready", "token": "SECRET"}),
            json.dumps({"provider": "openai-codex", "status": ["SECRET"]}),
            json.dumps({"provider": "openai-codex", "status": "SECRET"}),
        ]:
            with self.subTest(payload_length=len(payload)):
                self.env["FAKE_PI_RESPONSE"] = payload
                # Windows environment variables have a length limit; generate
                # oversized output in the fake CLI rather than its environment.
                if len(payload) > 32_000:
                    self.env.pop("FAKE_PI_RESPONSE")
                    self.env["FAKE_PI_OVERSIZED"] = "1"
                else:
                    self.env.pop("FAKE_PI_OVERSIZED", None)
                result = self.run_script()
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("invalid auth-check response", result.stderr)
                self.assertNotIn("SECRET", result.stdout + result.stderr)

    def test_inconsistent_exit_code_is_not_skipped(self):
        self.write_auth({"jetbrains": {"type": "oauth"}})
        self.env["FAKE_PI_EXIT"] = "3"
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertIn("invalid auth-check response (exit 3)", result.stderr)

    def test_arbitrary_failure_reason_is_not_logged(self):
        self.env["FAKE_PI_RESPONSE"] = json.dumps({
            "provider": "openai-codex", "status": "invalid", "reason": "SECRET-TOKEN",
        })
        self.env["FAKE_PI_EXIT"] = "2"
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertIn("reason: unknown reason", result.stderr)
        self.assertNotIn("SECRET", result.stdout + result.stderr)

    def test_timeout_continues_to_next_provider(self):
        self.write_auth({"slow": {"type": "oauth"}, "openai-codex": {"type": "oauth"}})
        result = self.run_script("--timeout", "1")
        self.assertEqual(result.returncode, 1)
        self.assertIn("timed out", result.stderr)
        self.assertEqual(len(self.calls()), 2)

    def test_rejects_unsafe_ids_without_invoking_them(self):
        self.write_auth({name: {"type": "oauth"} for name in [
            'bad" & echo injected', "%PATH%", "--credentials", "bad\nname", "openai-codex",
        ]})
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual(self.calls()[0]["args"][3], "openai-codex")
        self.assertNotIn("injected", result.stderr)

    def test_invalid_json_does_not_log_contents(self):
        self.auth_path.write_text('{"SECRET-TOKEN":', encoding="utf-8")
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertIn("JSONDecodeError", result.stderr)
        self.assertNotIn("SECRET-TOKEN", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_non_object_json_is_an_error(self):
        self.write_auth([])
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertIn("Expected a JSON object", result.stderr)

    def test_missing_auth_is_an_error(self):
        self.auth_path.unlink()
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertIn("FileNotFoundError", result.stderr)

    def test_no_oauth_does_not_require_pi(self):
        self.write_auth({"openai": {"type": "api_key"}})
        result = self.run_script("--pi", str(self.root / "missing"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls(), [])

    def test_missing_pi_is_an_error(self):
        result = self.run_script("--pi", str(self.root / "missing"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("Pi executable not found", result.stderr)

    def test_resolves_pi_from_path_including_windows_cmd(self):
        self.env["PATH"] = str(self.bin_dir) + os.pathsep + self.env.get("PATH", "")
        result = self.run_script(explicit_pi=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.calls()), 1)

    def test_respects_agent_directory_environment(self):
        self.env["PI_CODING_AGENT_DIR"] = str(self.agent_dir)
        result = self.run_script(explicit_agent_dir=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(Path(self.calls()[0]["agent_dir"]), self.agent_dir)

    def test_overlapping_run_skips_and_lock_is_reusable(self):
        with REFRESH.refresh_lock(self.agent_dir / "auth-refresh.lock") as acquired:
            self.assertTrue(acquired)
            result = self.run_script("--verbose")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("skipping", result.stderr)
            self.assertEqual(self.calls(), [])
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.calls()), 1)

    def test_invalid_timeout_is_rejected(self):
        for timeout in ["0", "-1", "nan", "inf"]:
            with self.subTest(timeout=timeout):
                result = self.run_script("--timeout", timeout)
                self.assertEqual(result.returncode, 2)
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
