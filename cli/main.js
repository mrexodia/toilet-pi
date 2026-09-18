import { parseArgs, stripVTControlCharacters } from "node:util";
import { randomUUID } from "node:crypto";
import { ToiletPiClient, authenticateAdmin, parseServerUrl } from "./client.js";
import { createAuthStore, resolveCredentials, promptLogin } from "./auth.js";

export const HELP = `Usage: toilet-pi [--server URL] [--timeout SECONDS] COMMAND

  login [URL]                        Prompt for admin token and save a server-bound login
  logout                             Remove the saved CLI login (local only)
  hosts                              List connected hosts and their IDs
  sessions [--host HOST]              List sessions (full IDs; unique prefixes accepted)
  status SESSION [--input ID]         Show mirrored state or reconcile an input
  models SESSION [FILTER]             List models WITH supported thinking levels
  model SESSION                      Read current model and thinking
  model SESSION PROVIDER/MODEL [--thinking LEVEL]
                                     Select model, optionally thinking in the same request
  thinking SESSION [LEVEL]            Read or select thinking level
  send SESSION [TEXT | --stdin] [--steer|--follow-up] [--wait]
                                     Submit tracked literal input (no slash expansion)
  wait SESSION --input ID             Wait for agent settlement, not task success
  abort SESSION                      Request abort (does NOT clear queued input)
  terminate SESSION                  Request graceful shutdown (not confirmed exit)
  resume SESSION                     Start an inactive runner, no inference
  new --host HOST --cwd PATH          Start a new runner, no inference
  history SESSION [--since ID] [--last N]
                                     Read sanitized branch transcript without resume
  watch SESSION                      Observe events for --timeout seconds

Run login once, then use commands without environment variables.
Saved login: ~/.pi/agent/toilet-pi-auth.json (override with --auth-file PATH).
Environment credentials remain optional overrides; with them, specify
--server or TOILET_PI_CLI_SERVER. Machine/agent configuration is never modified.
Remote connections require HTTPS; loopback HTTP is supported for local use.
Runtime model commands require an active session with an updated extension.
No implicit resume, inference, command replay, or configured-default changes.
Exit codes: 0 success/settlement, 1 transport/unknown outcome, 2 invalid arguments,
3 settled with provider error or abort. No automatic replay or reconnect.
Tracked input includes a visible correlation marker in the user message.
`;

export function compact(value) {
  return stripVTControlCharacters(String(value ?? "-")).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

function usage(message) {
  return Object.assign(new Error(message), { exitCode: 2 });
}

export function resolveSession(hosts, reference) {
  const sessions = hosts.flatMap(host => host.sessions.map(session => ({ ...session, host })));
  const exact = sessions.filter(session => session.sessionGuid === reference);
  const matches = exact.length ? exact : sessions.filter(session => session.sessionGuid.startsWith(reference));
  if (!matches.length) throw new Error(`Unknown session: ${compact(reference)}`);
  if (matches.length !== 1) throw new Error(`Ambiguous session: ${compact(reference)}; use a full ID`);
  return matches[0];
}

function resolveHost(hosts, reference) {
  const exact = hosts.filter(host => host.hostId === reference);
  const matches = exact.length ? exact : hosts.filter(host => host.hostname === reference || host.hostId.startsWith(reference));
  if (matches.length !== 1) throw new Error(`${matches.length ? "Ambiguous" : "Unknown"} host: ${compact(reference)}; use its full ID`);
  return matches[0];
}

function state(session) {
  return session.busy ? "running" : session.owner ? "idle" : "inactive";
}

function renderConfiguration(configuration) {
  return `${compact(configuration.provider)}/${compact(configuration.modelId)} thinking=${compact(configuration.thinkingLevel)}`;
}

async function stdinText() {
  if (process.stdin.isTTY) throw usage("--stdin requires piped input");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 50 * 1024) throw usage("Input exceeds 50 KiB");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runCli(argv, {
  env = process.env,
  out = text => process.stdout.write(text),
  err = text => process.stderr.write(text),
  createClient = options => new ToiletPiClient(options),
  readStdin = stdinText,
  authStore,
  prompt = promptLogin,
  authenticate = authenticateAdmin,
} = {}) {
  let client;
  const secrets = [env.TOILET_PI_ADMIN_TOKEN, env.TOILET_PI_ORCHESTRATOR_TOKEN];
  const line = text => out(`${text}\n`);
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
        server: { type: "string" }, timeout: { type: "string" }, host: { type: "string" }, "auth-file": { type: "string" },
        thinking: { type: "string" }, help: { type: "boolean", short: "h" },
        stdin: { type: "boolean" }, steer: { type: "boolean" }, "follow-up": { type: "boolean" }, wait: { type: "boolean" },
        input: { type: "string" }, cwd: { type: "string" }, since: { type: "string" }, last: { type: "string" },
      } });
    } catch {
      throw usage("Invalid arguments; run toilet-pi --help");
    }
    const { values, positionals } = parsed;
    if (values.help || !positionals.length) { out(HELP); return 0; }
    const [command, reference, argument] = positionals;
    const counts = { login: [1, 2], logout: [1, 1], hosts: [1, 1], sessions: [1, 1], status: [2, 2], models: [2, 3], model: [2, 3], thinking: [2, 3],
      send: [2, 3], wait: [2, 2], abort: [2, 2], terminate: [2, 2], resume: [2, 2], new: [1, 1], history: [2, 2], watch: [2, 2] };
    if (!Object.hasOwn(counts, command)) throw usage(`Unknown command: ${compact(command)}`);
    const [min, max] = counts[command];
    if (positionals.length < min || positionals.length > max || (reference !== undefined && !reference.trim())) {
      throw usage(`Invalid arguments for ${command}; run toilet-pi --help`);
    }
    if (values.server !== undefined && !values.server.trim()) throw usage("--server requires a URL");
    if (values.host !== undefined && !["sessions", "new"].includes(command)) throw usage("--host is only valid for sessions/new");
    const flags = { stdin: ["send"], steer: ["send"], "follow-up": ["send"], wait: ["send"], input: ["status", "wait"], cwd: ["new"], since: ["history"], last: ["history"] };
    for (const [flag, commands] of Object.entries(flags)) if (values[flag] !== undefined && !commands.includes(command)) throw usage(`--${flag} is invalid for ${command}`);
    if (command === "new" && (!values.host?.trim() || !values.cwd?.trim())) throw usage("new requires --host and --cwd");
    if (command === "wait" && !values.input) throw usage("wait requires --input ID");
    if (values.input !== undefined && !/^[a-zA-Z0-9_-]{16,128}$/.test(values.input)) throw usage("Invalid input ID");
    if (values.steer && values["follow-up"]) throw usage("Choose --steer OR --follow-up");
    const last = values.last === undefined ? 100 : Number(values.last);
    if (!Number.isInteger(last) || last < 1 || last > 1000) throw usage("--last must be an integer from 1 to 1000");
    if (values.since !== undefined && (!values.since.trim() || values.since.length > 128)) throw usage("Invalid cursor");
    let inputText;
    if (command === "send") {
      if (values.stdin ? argument !== undefined : !argument) throw usage("send requires either TEXT or --stdin");
      inputText = values.stdin ? await readStdin() : argument;
      if (!inputText.trim() || Buffer.byteLength(inputText) > 50 * 1024) throw usage("Input must contain text and be at most 50 KiB");
    }
    if (values.thinking !== undefined && (command !== "model" || !argument)) throw usage("--thinking requires model SESSION PROVIDER/MODEL");
    const timeoutSeconds = values.timeout === undefined ? 20 : Number(values.timeout);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 3600) throw usage("--timeout must be between 0 and 3600 seconds (exclusive of 0)");
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    const level = command === "thinking" ? argument : values.thinking;
    if (level !== undefined && !levels.includes(level)) throw usage(`Invalid thinking level: ${compact(level)}`);
    let selection;
    if (command === "model" && argument) {
      const slash = argument.indexOf("/");
      if (slash <= 0 || slash === argument.length - 1) throw usage("Model must be PROVIDER/MODEL");
      selection = { provider: argument.slice(0, slash), modelId: argument.slice(slash + 1),
        ...(level !== undefined ? { thinkingLevel: level } : {}) };
    }
    if (values["auth-file"] !== undefined && !values["auth-file"].trim()) throw usage("--auth-file requires a path");
    const store = authStore || createAuthStore(values["auth-file"]);
    if (command === "logout") {
      const removed = await store.clear(values.server);
      line(removed ? "Saved CLI login removed (local only)" : "No saved CLI login");
      return 0;
    }
    if (command === "login") {
      if (reference && values.server) throw usage("Specify the login URL either positionally or with --server, not both");
      if (env.TOILET_PI_ORCHESTRATOR_TOKEN?.trim()) throw usage("Unset TOILET_PI_ORCHESTRATOR_TOKEN before logging in with an admin secret");
      const serverUrl = parseServerUrl(values.server || reference || env.TOILET_PI_CLI_SERVER || await prompt("Server URL: ")).href;
      const token = env.TOILET_PI_ADMIN_TOKEN?.trim() || await prompt("Admin token (hidden): ", { secret: true });
      secrets.push(token);
      const saved = await authenticate({ serverUrl, token, timeoutMs: timeoutSeconds * 1000 });
      secrets.push(saved.cookie, saved.cookie?.slice("toilet-pi-admin=".length));
      await store.write(saved);
      line(`Logged in to ${compact(serverUrl)}`);
      line(`Saved login: ${compact(store.path)}`);
      return 0;
    }
    const credentials = await resolveCredentials({ serverUrl: values.server || env.TOILET_PI_CLI_SERVER,
      token: env.TOILET_PI_ADMIN_TOKEN, orchestratorToken: env.TOILET_PI_ORCHESTRATOR_TOKEN }, store);
    secrets.push(credentials.sessionCookie, credentials.sessionCookie?.slice("toilet-pi-admin=".length));
    client = createClient({ ...credentials, timeoutMs: timeoutSeconds * 1000 });
    await client.connect();
    const hosts = client.overview.hosts;
    if (command === "hosts") {
      if (!hosts.length) line("No hosts");
      for (const host of hosts) line(`${compact(host.hostId)}  ${compact(host.hostname)}  ${host.connected ? "connected" : "offline"}  sessions=${host.sessions.length}`);
      return 0;
    }
    if (command === "sessions") {
      const selected = values.host ? [resolveHost(hosts, values.host)] : hosts;
      let count = 0;
      for (const host of selected) for (const session of host.sessions) {
        count++;
        line(`${compact(session.sessionGuid)}  ${compact(host.hostname)}  ${state(session)}  ${compact(session.sessionName || session.cwd)}`);
      }
      if (!count) line("No sessions");
      return 0;
    }
    if (command === "new") {
      const host = resolveHost(hosts, values.host);
      const data = await client.control("new", { hostId: host.hostId, cwd: values.cwd });
      line(`${compact(data.sessionGuid)}  running (no inference requested)`);
      return 0;
    }
    // Full IDs can reconcile a ledger entry even after its runner/session has
    // disappeared from discovery. Unknown prefixes are never guessed.
    const reconciling = command === "wait" || (command === "status" && values.input);
    const listed = hosts.some(h => h.sessions.some(s => s.sessionGuid.startsWith(reference)));
    const session = reconciling && !listed ? { sessionGuid: reference } : resolveSession(hosts, reference);
    const id = session.sessionGuid;
    const renderInput = input => {
      line(`Input: ${compact(input.inputId)}  ${compact(input.state)}`);
      if (input.state === "unknown") throw new Error("Input outcome unknown; inspect history before deciding whether to send new work");
      if (["failed", "aborted"].includes(input.state)) throw Object.assign(new Error(`Input ${input.state}; settlement is not task success`), { exitCode: 3 });
    };
    if (command === "send") {
      const inputId = randomUUID();
      // Print BEFORE transmission: a lost response must not lose the reconciliation ID.
      line(`Input ID: ${inputId}`);
      const data = await client.control("send", { sessionGuid: id, inputId, text: inputText,
        mode: values.steer ? "steer" : values["follow-up"] ? "followUp" : "prompt", requireSettled: !!values.wait });
      renderInput(values.wait ? await client.waitInput(id, inputId) : data.input);
      return 0;
    }
    if (command === "wait" || (command === "status" && values.input)) {
      renderInput(command === "wait" ? await client.waitInput(id, values.input) :
        (await client.control("get_input", { sessionGuid: id, inputId: values.input })).input);
      return 0;
    }
    if (["abort", "terminate", "resume"].includes(command)) {
      const data = await client.control(command, { sessionGuid: id });
      line(`${compact(id)}  ${command}: ${compact(data.status)}`);
      return 0;
    }
    if (command === "history") {
      const { history } = await client.control("history", { sessionGuid: id, last, ...(values.since ? { since: values.since } : {}) });
      line(`Source: ${compact(history.source)} sanitized=true complete=${history.complete} truncated=${history.truncated} leaf=${compact(history.leafId)}`);
      for (const m of history.messages) line(`${compact(m.entryId)} ${compact(m.role)}: ${compact(m.text)}`);
      line(`Cursor: ${compact(history.nextCursor)} more=${history.hasMore}`);
      return 0;
    }
    if (command === "watch") {
      line(`Watching ${compact(id)} for ${timeoutSeconds}s (no replay)`);
      let bytes = 0;
      await client.watch(id, event => {
        const text = event.type === "message" ? `${compact(event.message.role)}: ${compact(event.message.text)}` :
          event.type === "input_status" ? `input ${compact(event.input.inputId)} ${compact(event.input.state)}` : compact(event.type);
        if (bytes > 1024 * 1024) return;
        bytes += Buffer.byteLength(text);
        line(bytes > 1024 * 1024 ? "[watch output truncated at 1 MiB]" : text);
      });
      return 0;
    }
    if (command === "status") {
      const snapshot = await client.snapshot(id);
      line(`${compact(id)}  ${compact(session.host.hostname)}  ${state(snapshot)}`);
      line(`Name: ${compact(snapshot.sessionName)}`);
      line(`Cwd: ${compact(snapshot.cwd)}`);
      line(`Model: ${snapshot.configuration ? renderConfiguration(snapshot.configuration) : compact(snapshot.model) + " (thinking unknown)"}`);
      line(`Queued: ${snapshot.queuedInputs.length}`);
      line("Source: mirrored status (not a fresh runtime query)");
      return 0;
    }
    if (command === "models") {
      const data = await client.request(id, "get_models");
      const models = data.models.filter(model => !argument || `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(argument.toLowerCase()));
      for (const model of models) line(`${compact(model.provider)}/${compact(model.id)}  ${model.thinkingLevels.map(compact).join(" ")}`);
      if (!models.length) line("No matching models");
      line(`Current: ${renderConfiguration(data.configuration)}`);
      return 0;
    }
    if (command === "thinking" && argument) selection = { thinkingLevel: argument };
    const data = await client.request(id, selection ? "configure" : "get_config", selection);
    line(`${selection ? "Configured" : "Current"} ${compact(id)}: ${renderConfiguration(data.configuration)}`);
    return 0;
  } catch (error) {
    // Generic auth/transport diagnostics plus explicit secret redaction protect
    // against a server error reflecting a credential into its message.
    let message = String(error.message || "Command failed");
    for (const secret of secrets.flatMap(value => [value, value?.trim()])) if (secret) message = message.split(secret).join("[REDACTED]");
    err(`error: ${compact(message)}\n`);
    return error.exitCode || 1;
  } finally {
    client?.close();
  }
}
