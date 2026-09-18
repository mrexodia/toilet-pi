import { parseArgs, stripVTControlCharacters } from "node:util";
import { ToiletPiClient } from "./client.js";

export const HELP = `Usage: toilet-pi [--server URL] [--timeout SECONDS] COMMAND

  hosts                              List connected hosts and their IDs
  sessions [--host HOST]              List sessions (full IDs; unique prefixes accepted)
  status SESSION                     Show mirrored session status
  models SESSION [FILTER]             List models WITH supported thinking levels
  model SESSION                      Read current model and thinking
  model SESSION PROVIDER/MODEL [--thinking LEVEL]
                                     Select model, optionally thinking in the same request
  thinking SESSION [LEVEL]            Read or select thinking level

Set TOILET_PI_CLI_SERVER and TOILET_PI_ADMIN_TOKEN, or pass --server.
No credentials or machine configuration are read from/written to disk.
Remote connections require HTTPS; loopback HTTP is supported for local use.
Runtime model commands require an active session with an updated extension.
No implicit resume, inference, command replay, or configured-default changes.
Exit codes: 0 success, 1 connection/runtime failure, 2 invalid arguments.
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

export async function runCli(argv, {
  env = process.env,
  out = text => process.stdout.write(text),
  err = text => process.stderr.write(text),
  createClient = options => new ToiletPiClient(options),
} = {}) {
  let client;
  const line = text => out(`${text}\n`);
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
        server: { type: "string" }, timeout: { type: "string" }, host: { type: "string" },
        thinking: { type: "string" }, help: { type: "boolean", short: "h" },
      } });
    } catch {
      throw usage("Invalid arguments; run toilet-pi --help");
    }
    const { values, positionals } = parsed;
    if (values.help || !positionals.length) { out(HELP); return 0; }
    const [command, reference, argument] = positionals;
    const counts = { hosts: [1, 1], sessions: [1, 1], status: [2, 2], models: [2, 3], model: [2, 3], thinking: [2, 3] };
    if (!Object.hasOwn(counts, command)) throw usage(`Unknown command: ${compact(command)}`);
    const [min, max] = counts[command];
    if (positionals.length < min || positionals.length > max || (reference !== undefined && !reference.trim())) {
      throw usage(`Invalid arguments for ${command}; run toilet-pi --help`);
    }
    if (values.host !== undefined && command !== "sessions") throw usage("--host is only valid for sessions");
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
    client = createClient({ serverUrl: values.server || env.TOILET_PI_CLI_SERVER,
      token: env.TOILET_PI_ADMIN_TOKEN, timeoutMs: timeoutSeconds * 1000 });
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
    const session = resolveSession(hosts, reference);
    const id = session.sessionGuid;
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
    if (env.TOILET_PI_ADMIN_TOKEN) message = message.split(env.TOILET_PI_ADMIN_TOKEN).join("[REDACTED]");
    err(`error: ${compact(message)}\n`);
    return error.exitCode || 1;
  } finally {
    client?.close();
  }
}
