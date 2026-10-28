# Claude Code on Toilet-Pi

A Claude Code plugin: every [Claude Code](https://code.claude.com) session on a connected machine shows up on the hub
next to your pi, OMP and Optchat sessions. From the web UI or the CLI you can watch it, send it prompts, answer its
permission prompts and abort its run, while it stays a normal interactive session in its terminal.

The repository root is the plugin (`.claude-plugin/plugin.json`); everything it runs lives in this folder.

## How it works

```text
Browser / toilet-pi CLI
          │
          ▼
  Central Toilet-Pi server
          ▲
          │ WebSocket (machine connect URL)
          │
 plugin MCP server      ◀── hooks (hook.js) ── session id, transcript, turn start/stop, abort point
 (start.js → bridge.js, ──▶ channel events ──▶ remote prompts and permission verdicts into the live session
  one per session)
          │
          ▼
   ~/.claude/projects/…/<session>.jsonl  (mirrored to the hub as it grows)
```

- **Bridge.** Claude Code starts the plugin's `toilet-pi` MCP server (`start.js`, which runs `bridge.js`) for every
  session. It connects to the hub as an
  `interactive` session, exactly like `toilet-pi.ts` and Optchat do, using the same machine connect URL and reconnect
  logic. The hub session id is Claude Code's own session id; `/clear` switches the bridge to the new one.
- **Channel.** The bridge is a Claude Code [channel](https://code.claude.com/docs/en/channels-reference): hub input
  is pushed into the live session as a `<channel source="plugin:toilet-pi:toilet-pi">` event, and Claude Code relays its tool
  permission prompts to the bridge, which shows them on the hub.
- **Hooks.** `hook.js` runs on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
  `PostToolUseFailure`, `Stop`, `Notification` and `SessionEnd`. It finds its session's bridge through the process tree (both are children of the same `claude`
  process), so sessions in the same folder never mix. It tells the bridge when turns start and stop, which is how
  `send --wait` settles, and gives it a tool boundary at which to stop an aborted run.
- **Transcript.** The bridge tails the session's JSONL transcript and mirrors user prompts, replies, thinking and tool
  results, plus the model, context size and cost.

## Setup

Install the plugin from a marketplace that lists it, such as
[mrexodia/claude-marketplace](https://github.com/mrexodia/claude-marketplace):

```bash
claude plugin marketplace add mrexodia/claude-marketplace
claude plugin install toilet-pi@mrexodia
```

It connects with the machine connect URL that `/toilet-pi setup` saved for pi on this machine. On a machine without
pi, generate a connect URL in the web UI (**Installation**) and set it as the plugin's option, in Claude Code with
`/plugin` → toilet-pi → configure, or from a shell:

```bash
echo '{"connect_url": "wss://your-server/ws?token=…"}' | claude plugin configure toilet-pi@mrexodia --values-stdin
```

From then on every new Claude Code session is **visible** on the hub. To also **control** it remotely, start
Claude with the plugin's channel enabled:

```bash
claude --dangerously-load-development-channels plugin:toilet-pi@mrexodia
```

Channels are a Claude Code research preview: channels outside Anthropic's allowlist need this development flag,
Claude asks you to confirm it at each launch, and Team/Enterprise organizations must allow channels. An alias makes
it the default:

```bash
alias claude='claude --dangerously-load-development-channels plugin:toilet-pi@mrexodia'
```

The bridge needs the `ws` package. Claude Code normally installs the repository's dependencies along with the
plugin; when it hasn't, `start.js` installs `ws` once into the plugin's data directory (`${CLAUDE_PLUGIN_DATA}`, kept
across updates). To work on the plugin from a checkout, run `npm install` there and start Claude with
`claude --plugin-dir /path/to/toilet-pi`.

## Use

```bash
toilet-pi sessions
toilet-pi send <session> 'run the tests and fix what fails' --wait
toilet-pi history <session> --last 10
toilet-pi abort <session>
```

- **Prompts** start a turn when Claude is idle. Sent while it is busy (the web UI does this, or `--steer` /
  `--follow-up`), they are queued and Claude picks them up after the current turn. A plain `send` to a busy session
  fails, as for pi.
- **Permission prompts** appear in the session as `🔐 Claude wants to use Bash: …` with a five-letter request id.
  Reply `yes abcde` or `no abcde`, or just `yes` / `no` when only one prompt is open. The terminal dialog stays open
  too, and whichever answer comes first wins.
- **Abort** stops the run at the next tool boundary: a tool that is already running finishes, then the turn ends and
  the input reports `aborted`. Claude Code has no remote interrupt, so a reply being generated without tool calls
  runs to the end. Like pi's abort, it leaves queued input alone. Pressing Esc in the terminal also ends the turn
  as `aborted` on the hub.
- **Close** (the web UI's close-session action, or `toilet-pi terminate`) ends the Claude Code process, as it does
  for pi: the run is aborted and given up to 5 seconds to stop, then Claude Code gets SIGTERM, restores the terminal
  and exits. The transcript is kept, so `claude --resume` continues the session. The bridge only does this when its
  parent process is verifiably Claude Code; otherwise `terminate` fails as `unsupported`.

## Limits

- Remote input needs the channel flag above. Without it, inputs are reported as failed after 30 seconds with an
  explanation in the session, rather than hanging.
- Replies appear when Claude Code writes them to the transcript, a block at a time, not token by token.
- No remote model or thinking selection, and Claude Code sessions don't launch new sessions (`new`) or resume
  inactive ones; a session is on the hub while its `claude` process runs, so a closed session can only be
  continued from a terminal.
- Subagent (sidechain) activity is not mirrored, only the main conversation.
- Linux and macOS. On Windows the bridge starts but stays inert.
- Each hook is a short Node process, so every tool call costs a few tens of milliseconds.

## Settings

| Variable | Effect |
| --- | --- |
| `TOILET_PI_SERVER_URL` | Machine connect URL, used when the plugin's `connect_url` option is empty; otherwise the one `/toilet-pi setup` saved is used. |
| `TOILET_PI_CLAUDE=0` | Turn the integration off for one session: the bridge stays inert and hooks do nothing. |
| `TOILET_PI_SESSION_NAME` | The session's name on the hub (otherwise Claude Code's `/rename` title, else the first message). |
| `TOILET_PI_HOST_ID` | Host id sent in the hello, as for the pi extension. |
| `TOILET_PI_CLAUDE_LOG` | Append the bridge's log to this file. Claude Code's own debug log keeps little of it. |

## Development

`npm test` covers the transcript parser and the hook→bridge lookup. `claude plugin validate .` checks the manifest. `npm run claude:e2e` starts a real hub on a free
port, plays the part of Claude Code around the real bridge, hook and CLI, and checks mirroring, remote prompts,
permission relay, abort, undelivered input, `/clear` and shutdown.

The plugin was also checked against real interactive Claude Code 2.1.311 driven through a pseudo-terminal, installed
from a git URL marketplace: a `toilet-pi send --wait` ran a command in the live session and settled, a forced
permission prompt was approved with a bare `yes` from the hub, an abort stopped a three-step run after its first
tool, Esc ended the turn, and the connect URL option and the `${CLAUDE_PLUGIN_DATA}` install of `ws` both worked.
Findings from those runs shape the code: Claude Code fires no `Stop` hook after a hook ends a turn with
`continue: false` or after a user interrupt, so the bridge ends those turns itself; channel messages are stored in
the transcript as meta entries with a channel origin; and a plugin channel's `source` is namespaced.
