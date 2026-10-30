#!/usr/bin/env python3
"""Refresh stored Pi OAuth credentials through the installed CLI (Python 3.9+)."""

import argparse
from contextlib import contextmanager
import errno
import json
import logging
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile

if os.name == "nt":
    import msvcrt
else:
    import fcntl


@contextmanager
def refresh_lock(path):
    """Skip overlapping script runs without interfering with Pi's own auth lock."""
    with path.open("a+b") as lock:
        if lock.seek(0, os.SEEK_END) == 0:
            lock.write(b"\0")
            lock.flush()
        lock.seek(0)
        try:
            if os.name == "nt":
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                raise
            yield False
            return
        try:
            yield True
        finally:
            lock.seek(0)
            if os.name == "nt":
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        # Do not unlink: another process may already have opened this inode.


def check_provider(pi, provider, agent_dir, timeout):
    env = os.environ.copy()
    env["PI_CODING_AGENT_DIR"] = str(agent_dir)
    command = [pi, "auth", "check", "--provider", provider, "--json"]
    if os.name == "nt" and Path(pi).suffix.lower() in (".cmd", ".bat"):
        # cmd.exe needs its own quoting, not subprocess.list2cmdline(). Expand
        # paths through env once so literal %, !, &, and spaces stay literal.
        env["_PI_REFRESH_AUTH_CLI"] = pi
        env["_PI_REFRESH_AUTH_PROVIDER"] = provider
        cmd = Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe"
        command = (
            f'"{cmd}" /d /v:off /s /c '
            '""%_PI_REFRESH_AUTH_CLI%" auth check --provider "%_PI_REFRESH_AUTH_PROVIDER%" --json"'
        )

    # A temporary file avoids pipe-buffer deadlocks and keeps CLI output private.
    with tempfile.TemporaryFile() as output, subprocess.Popen(
        command,
        env=env,
        cwd=agent_dir,
        stdin=subprocess.DEVNULL,
        stdout=output,
        stderr=subprocess.DEVNULL,
        start_new_session=os.name != "nt",
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    ) as process:
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            # Kill the tree too: pi.cmd starts Node, and killing only cmd.exe
            # would leave its child running after the script releases its lock.
            if os.name == "nt":
                try:
                    subprocess.run(
                        [str(Path(os.environ["SystemRoot"]) / "System32" / "taskkill.exe"),
                         "/pid", str(process.pid), "/t", "/f"],
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        timeout=10,
                        check=False,
                        creationflags=subprocess.CREATE_NO_WINDOW,
                    )
                except (OSError, subprocess.TimeoutExpired):
                    pass
                if process.poll() is None:
                    process.kill()
            else:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            process.wait()
            logging.error("%s: timed out after %s seconds", provider, timeout)
            return False
        output.seek(0)
        payload = output.read(65_537)

    try:
        result = json.loads(payload) if len(payload) <= 65_536 else None
    except (ValueError, UnicodeError):
        result = None
    expected_codes = {"ready": 0, "not_ready": 1, "invalid": 2}
    if (
        not isinstance(result, dict)
        or result.get("provider") != provider
        or not isinstance(result.get("status"), str)
        or expected_codes.get(result["status"]) != code
    ):
        logging.error("%s: invalid auth-check response (exit %s)", provider, code)
        return False
    status = result["status"]
    reason = result.get("reason")
    if status == "not_ready" and reason == "provider_not_found":
        logging.info("%s: skipped (provider not recognized by installed Pi)", provider)
        return True
    if status == "ready":
        logging.info("%s: ready", provider)
        return True
    # Never echo arbitrary CLI fields; unexpected output could contain secrets.
    if reason not in ("credentials_not_configured", "invalid_state", "credential_not_available"):
        reason = "unknown reason"
    logging.error("%s: %s (exit %s; reason: %s)", provider, status, code, reason)
    return False


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pi", default="pi", help="Pi executable or Windows .cmd path (default: pi on PATH)")
    parser.add_argument(
        "--agent-dir", default=os.environ.get("PI_CODING_AGENT_DIR") or "~/.pi/agent",
        help="Pi config directory (default: PI_CODING_AGENT_DIR or ~/.pi/agent)",
    )
    parser.add_argument("--timeout", type=float, default=60, help="Timeout per provider in seconds (default: 60)")
    parser.add_argument("--verbose", action="store_true", help="Also log successful checks and skipped runs")
    args = parser.parse_args(argv)
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("--timeout must be a finite positive number")
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    agent_dir = Path(args.agent_dir).expanduser().resolve()
    auth_path = agent_dir / "auth.json"
    try:
        with refresh_lock(agent_dir / "auth-refresh.lock") as acquired:
            if not acquired:
                logging.info("Another refresh run is active; skipping")
                return 0
            try:
                with auth_path.open(encoding="utf-8-sig") as auth_file:
                    auth = json.load(auth_file)
            except (OSError, UnicodeError, ValueError) as error:
                # Do not log exception text: malformed JSON can contain secrets.
                logging.error("Cannot read %s (%s)", auth_path, type(error).__name__)
                return 1
            if not isinstance(auth, dict):
                logging.error("Expected a JSON object in %s", auth_path)
                return 1
            providers = [
                provider for provider, credential in auth.items()
                if isinstance(credential, dict) and credential.get("type") == "oauth"
            ]
            if not providers:
                logging.info("No stored OAuth providers")
                return 0
            pi = shutil.which(os.path.expanduser(args.pi))
            if pi is None:
                logging.error("Pi executable not found; set --pi to its absolute path")
                return 1
            pi = os.path.abspath(pi)
            success = True
            for provider in providers:
                # No shell metacharacters, whitespace, or flags from auth.json.
                if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", provider):
                    logging.error("Skipping an OAuth entry with an unsafe provider ID")
                    success = False
                    continue
                try:
                    if not check_provider(pi, provider, agent_dir, args.timeout):
                        success = False
                except OSError as error:
                    logging.error("%s: cannot launch Pi (%s)", provider, type(error).__name__)
                    success = False
            return 0 if success else 1
    except OSError as error:
        logging.error("Cannot access refresh lock in %s (%s)", agent_dir, type(error).__name__)
        return 1


if __name__ == "__main__":
    sys.exit(main())
