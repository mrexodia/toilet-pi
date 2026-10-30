# Refresh Pi OAuth credentials on a schedule

`pi-refresh-auth.py` runs once and exits. It reads the OAuth provider names from
`auth.json` and invokes the installed `pi auth check --provider <id> --json` for each.
Pi owns refresh decisions, token exchange, credential locking, and persistence.
No agent sessions, extensions, or LLM requests are needed.

Requires Python 3.9+ and a Pi version supporting `pi auth check` (such as 1.3.0).
There are no Python package dependencies. The script supports Linux, macOS, and
Windows, including Windows `pi.cmd` and `pi.bat` launchers.

## Run manually

```sh
python3 scripts/pi-refresh-auth.py --verbose
```

On Windows, for example:

```powershell
py -3 scripts/pi-refresh-auth.py --pi "C:\Users\YOUR_USER\AppData\Roaming\npm\pi.cmd" --verbose
```

Options:

- `--pi`: executable name on PATH or an explicit executable/`.cmd`/`.bat` path.
  Defaults to `pi`. Prefer an absolute, stable launcher path in scheduled jobs,
  not a version-specific installation path. Each run uses the installed version.
- `--agent-dir`: Pi configuration directory, containing `auth.json`. Defaults to
  `PI_CODING_AGENT_DIR`, then `~/.pi/agent`. The same directory is passed to Pi.
- `--timeout`: timeout per provider in seconds; defaults to 60.
- `--verbose`: log successful checks, skipped overlapping runs, and no-op runs.
  By default, only failures are logged.

Entries that Pi reports as `provider_not_found` are skipped: they may belong to
an older installation or a provider unavailable to the standalone auth command.
They are logged only with `--verbose` and are never removed from `auth.json`.
Other `not_ready` results and `invalid` results remain failures.

The script exits with status 0 when all checks succeed or are skipped, there are
no stored OAuth providers, or another run already holds its lock. It exits with
status 1 for configuration errors, malformed CLI responses, or any failed/timed-out
provider check, and 2 for invalid arguments. Failures do not prevent checking the
remaining providers.

The script never edits `auth.json` itself or logs credentials. Child stdout is
parsed privately; stderr is discarded. Logs contain status, exit code, and known
reason codes, never raw CLI output. To investigate a failed check, run
`pi auth check --provider <id> --json` manually, without `--credentials`.
Invalid JSON is an error, not an empty credential store. Provider IDs must start
with an ASCII letter or digit and contain only ASCII letters, digits, `_`, `-`,
or `.`; other IDs are rejected rather than passed to a Windows command shell.

## Linux/macOS cron

Copy the script to a stable location and run it as the same user who uses Pi.
Adjust all paths below:

```cron
* * * * * /usr/bin/python3 /home/YOUR_USER/.local/bin/pi-refresh-auth.py --pi /home/YOUR_USER/.local/bin/pi >> /home/YOUR_USER/.pi/agent/auth-refresh.log 2>&1
```

Schedule every minute. Pi refreshes only when the access token expires within
five minutes; an hourly schedule can miss that window. This is best-effort
maintenance, not a guarantee of continuous validity during network outages or
machine sleep. Revoked refresh tokens still require logging in again.

Cron has a minimal environment: ensure Node is also on PATH if your Pi launcher
needs it. Logs should be rotated if failures persist.

The script takes a nonblocking OS lock on `<agent-dir>/auth-refresh.lock` and
skips overlapping script runs. No external `flock` utility is needed. Leave the
lock file in place; the OS releases the lock when the process exits. This is
separate from Pi's internal credential-store lock.

## Windows Task Scheduler

Create a task under the same Windows account that uses Pi:

- Program: the absolute path to `pythonw.exe`.
- Arguments: `"C:\Tools\pi-refresh-auth.py" --pi "C:\path\to\pi.cmd"`.
- Trigger: repeat every 1 minute indefinitely.
- Multiple instances: do not start a new instance (the script also locks).

Ensure Node is on the task's PATH if the launcher needs it. For a nondefault Pi
configuration directory, supply `--agent-dir` explicitly. Task Scheduler records
the exit code but does not retain console output; redirect stderr through a
wrapper if persistent logs are needed. The script does not install scheduled
tasks or modify cron automatically.

## Offline tests

From the repository root:

```sh
python -B -m unittest discover -s scripts -p test_pi_refresh_auth.py -v
```

Tests use fake CLI processes and temporary credential stores, never real tokens
or provider endpoints. Windows runs exercise real `.cmd` execution, PATH lookup,
quoting, timeout handling, and overlapping-run locking.
