# Toilet-Pi agent

A long-running agent with a memory that never ends, built on
[`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable), and driven through
Toilet-Pi like any other session: it shows up in the web UI and the CLI, takes prompts, steers other agents on the hub,
and gets their answers back as messages.

Its memory is the design of Victor Taelin's [optchat.md](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449): one chat that is logged forever,
compressed in the background into a binary tree of 512-byte summaries, and shown to the model as a 64-128 KB **view**
that covers the whole chat, recent lines fine and old ones coarse. The model zooms into a line when it needs more.
Nothing is ever compacted by hand and nothing is lost.

## Setup

```bash
cd toilet-pi
npm run optchat:setup        # installs pi-durable, pi-ai and pi-coding-agent under optchat/
```

Models and logins are pi's own: run `pi`, then `/login` for a Codex or Claude subscription, or add a provider to
`~/.pi/agent/models.json`. The agent uses pi's default model unless told otherwise.

Give the agent a directory of its own, and run the wizard there:

```bash
npm run optchat -- --home ~/optchat setup
```

It asks for the session's name on the hub (or none, so the hub shows the first message, as for any session), the turns' model and thinking level, the compactions' model and thinking
level (a fast, cheap model is right for the summaries), the machine connect URL if pi has none saved, and whether
to log in for the agent's own hub tools. The answers go to `optchat.json` in the home, and a starter
`instructions.md` is written there: it follows the system prompt in every call, so say who you are, how your files
are organized and how you want work done. The memory lives in `.optchat/` under the home, and the shell, read,
write and edit tools run there.

The model and thinking level can also be changed from Toilet-Pi while the agent runs (the web UI's picker, or
`toilet-pi model optchat provider/id --thinking high`), and the change is saved to `optchat.json`. The compactions'
model is only set in `optchat.json`, by the wizard or by hand.

The home can carry more, loaded once at start and never from pi's global directories:

- `.env`: `KEY=VALUE` lines put into the environment, for the shell, skills and extensions. Secrets stay out of
  `optchat.json` and out of the transcript, as long as commands name the variable rather than its value.
- `skills/<name>/SKILL.md`: pi-format skills (a `name` and a `description` in the frontmatter). The prompt lists
  them; the model reads one with its `read` tool when a task matches. A web search through Jina is a skill with
  one `curl` line and no code.
- `extensions/*.ts`: pi-durable extensions, for real tools, hooks and background tasks. A file exports either an
  extension object or a function that receives a kit (`defineExtension`, `defineTool`, `Type`, `defineTask`,
  `section`, `hook`, ..., plus `home` and `env`) and returns one, so it needs no imports of its own.

They reload in place: when a file under `skills/` or `extensions/` or `.env` changes, and when the agent calls its
`reload` tool. The prompt tells the agent how to write a skill or an extension for itself, so "add yourself a tool
for X" works: it writes the file, reloads, sees any error, and has the tool from its next step. A reload rewrites
the cached prompt once.

## Run

```bash
npm run optchat -- --home ~/optchat                      # a local chat: each line you type is a turn
npm run optchat -- --home ~/optchat say "..."            # one turn
npm run optchat -- --home ~/optchat serve               # a session on the Toilet-Pi hub, until stopped
npm run optchat -- --home ~/optchat status | view | zoom ID [N [AT]] | compact | note "..."
```

`serve` connects with the machine connect URL that `/toilet-pi setup` saved in pi (or `TOILET_PI_SERVER_URL`), as an
interactive session, named by `optchat.json` or `--name` if you gave it a name. Then:

```bash
toilet-pi sessions
toilet-pi send optchat 'look into the flaky build' --wait
toilet-pi history optchat --last 6
```

For the agent's own tools that drive other sessions (`agents`, `agent_send`, `agent_history`, `agent_abort`,
`agent_resume`, `agent_new`), give it the CLI's saved login (`toilet-pi login`) or a scoped token in
`TOILET_PI_ORCHESTRATOR_TOKEN` with `TOILET_PI_CLI_SERVER`. A task sent with `agent_send` returns at once; a durable
reporter task waits for the other session to settle and posts its answer into the chat as a message starting
`[name] report`, which starts a turn.

Run `serve` as a service (systemd, launchd, Task Scheduler) so it is always up. One process owns a home directory at a
time; `status`, `view` and `zoom` only read and can run beside it.

Options and environment variables, each overriding `optchat.json` for one run:

| Option | Variable | Meaning |
|---|---|---|
| `--home DIR` | `OPTCHAT_HOME` | the agent's directory (default `~/.optchat-agent`) |
| `--model provider/id` | `OPTCHAT_MODEL` | the turns' model (default: pi's default) |
| `--compactor provider/id` | `OPTCHAT_COMPACTOR` | the compactions' model (default: the turns' model; a cheap one is fine) |
| `--thinking LEVEL` | `OPTCHAT_THINKING` | the turns' thinking level |
| `--compactor-thinking LEVEL` | | the compactions' thinking level |
| `--name NAME` | `OPTCHAT_NAME` | the session's name on the hub |

## How it is built

- `src/optchat/tree.ts`: the tree, the view and its merge order (the rollback push of optchat.md 3.1), as pure code.
- `src/optchat/docs.ts`: the memory's durable state as pi-durable documents: the chat state, one small document per
  message, one per built node.
- `src/optchat/compactor.ts`: the indexer that numbers transcript entries as messages, the pump that starts what is
  ready, and the `Build` task that makes one node with a model call, with retries and the "Too long" cut.
- `src/optchat/extension.ts`: the system prompt, the `zoom` and `date` tools, the hook that gives each request
  `[tools] [system] [view] [message]` with the view frozen for the run, and the hook that clips tool output.
- `src/runner.ts`: the Toilet-Pi runner protocol, with the hub's input ids as durable request ids.
- `src/orchestrate.ts`: the hub tools and the reporter task.
- `src/host.ts`: pi's model runtime and settings, the Harness over SQLite, the coding tools.

What differs from the document, knowingly:

- Thoughts are never summarized and never shown, but they stay in the durable transcript, because providers need
  them back during a run's tool calls. The document never logs them at all.
- Anthropic's explicit cache marks on four-line view blocks are not placed: pi-ai marks only the last block of the
  last message. With OpenAI-style automatic prefix caching, which Codex uses, the frozen view is cached as a prefix
  without marks.
- The compactions' model does not have to be the turns' model, so a compaction may not share the turns' cache entry.
- Images and `zoom("Name")` into a subagent's log are absent; other agents are hub sessions reached through tools.

Every message is a transcript entry committed before it is shown. Every node, queue change and view change is a
commit on the same line. A compaction is a durable task: a crash resumes it. Tests: `npm run optchat:test`.
