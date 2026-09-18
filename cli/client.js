import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

export function parseServerUrl(value) {
  if (!value) throw new Error("Specify --server or TOILET_PI_CLI_SERVER, or run toilet-pi login");
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid server URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an http(s) server URL without credentials, query, or fragment; provide TOILET_PI_ADMIN_TOKEN separately");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.protocol !== "https:" && !loopback) throw new Error("Remote servers require HTTPS");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

export function validCookie(cookie) {
  return typeof cookie === "string" && /^toilet-pi-admin=[A-Za-z0-9._~-]+$/.test(cookie) && cookie.length <= 32768;
}

export async function authenticateAdmin({ serverUrl, token, timeoutMs = 20000 }) {
  const url = parseServerUrl(serverUrl);
  if (!token?.trim()) throw new Error("Admin token must not be empty");
  let response;
  try {
    response = await fetch(new URL("auth/login", url), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token.trim() }), redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { throw new Error("Login connection failed or timed out"); }
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Login failed (HTTP ${response.status}); use an admin login secret`);
  const header = response.headers.getSetCookie().find(value => value.startsWith("toilet-pi-admin="));
  const cookie = header?.split(";", 1)[0];
  if (!validCookie(cookie)) throw new Error("Login did not return a valid admin session cookie");
  const age = header.match(/;\s*max-age=(\d+)(?:;|$)/i);
  const expires = header.match(/;\s*expires=([^;]+)/i);
  const expiresAt = age ? Date.now() + Number(age[1]) * 1000 : expires ? Date.parse(expires[1]) : undefined;
  if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) throw new Error("Login returned an expired session cookie");
  return { serverUrl: url.href, cookie, ...(expiresAt !== undefined ? { expiresAt } : {}) };
}

export class ToiletPiClient {
  constructor({ serverUrl, token, orchestratorToken, sessionCookie, timeoutMs = 20000 }) {
    this.serverUrl = parseServerUrl(serverUrl);
    if ([token?.trim(), orchestratorToken?.trim(), sessionCookie].filter(Boolean).length !== 1) throw new Error("Provide exactly one credential: saved login, admin secret, or orchestrator token");
    if (sessionCookie && !validCookie(sessionCookie)) throw new Error("Invalid saved login; run toilet-pi login again");
    this.sessionCookie = sessionCookie;
    this.token = token?.trim();
    this.orchestratorToken = orchestratorToken?.trim();
    this.timeoutMs = timeoutMs;
    this.waiters = new Set();
    this.listeners = new Set();
    this.overview = null;
    this.closed = false;
  }

  async loginCookie() {
    try {
      return (await authenticateAdmin({ serverUrl: this.serverUrl.href, token: this.token, timeoutMs: this.timeoutMs })).cookie;
    } finally { this.token = undefined; }
  }

  async connect() {
    const savedLogin = !!this.sessionCookie;
    const cookie = this.orchestratorToken ? undefined : this.sessionCookie || await this.loginCookie();
    const wsUrl = new URL("ws", this.serverUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(wsUrl, {
      headers: { ...(cookie ? { Cookie: cookie } : { Authorization: `Bearer ${this.orchestratorToken}` }), Origin: this.serverUrl.origin },
      handshakeTimeout: this.timeoutMs,
      maxPayload: 8 * 1024 * 1024,
      followRedirects: false,
    });
    this.orchestratorToken = undefined;
    this.sessionCookie = undefined;
    const ready = this.waitFor(message => message.type === "overview");
    this.ws.on("open", () => this.send({ type: "hello", role: "web" }));
    this.ws.on("message", data => {
      let message;
      try {
        message = JSON.parse(String(data));
        if (!message || typeof message !== "object" || typeof message.type !== "string") throw new Error("Invalid message");
      } catch {
        this.fail(new Error("Server returned invalid JSON"));
        this.ws.terminate();
        return;
      }
      if (message.type === "overview") this.overview = message;
      try { for (const listener of this.listeners) listener(message); }
      catch { this.fail(new Error("Event consumer failed")); this.ws.terminate(); return; }
      if (message.type === "error") {
        this.fail(new Error(message.message || "Server rejected the request"));
        return;
      }
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(message)) waiter.resolve(message);
      }
    });
    this.ws.on("error", () => this.fail(new Error(savedLogin
      ? "WebSocket connection failed or saved login rejected; run toilet-pi login if expired. Command outcome may be unknown."
      : "WebSocket connection failed; command outcome may be unknown")));
    this.ws.on("close", () => {
      this.closed = true;
      this.fail(new Error("Disconnected; command outcome may be unknown. Inspect state before retrying."));
    });
    await ready;
    return this;
  }

  waitFor(predicate, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error("Client is disconnected")); return; }
      const done = (fn, value) => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        fn(value);
      };
      const waiter = { predicate,
        resolve: value => done(resolve, value),
        reject: error => done(reject, error),
      };
      const timer = setTimeout(() => waiter.reject(new Error(
        "Request timed out; command outcome may be unknown. Inspect state before retrying.",
      )), timeoutMs);
      this.waiters.add(waiter);
    });
  }

  fail(error) {
    for (const waiter of [...this.waiters]) waiter.reject(error);
  }

  send(message) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.fail(new Error("Client is not connected"));
      return;
    }
    this.ws.send(JSON.stringify(message), error => {
      if (error) this.fail(new Error("Send failed; command outcome may be unknown"));
    });
  }

  async request(sessionGuid, operation, selection = {}) {
    const requestId = randomUUID();
    const result = this.waitFor(message => message.type === "session_response" &&
      message.requestId === requestId && message.sessionGuid === sessionGuid);
    this.send({ type: "session_request", requestId, sessionGuid, operation, ...selection });
    const response = await result;
    if (!response.success) throw new Error(`${response.error?.code || "failed"}: ${response.error?.message || "Session request failed"}`);
    return response.data;
  }

  async control(operation, fields = {}, timeoutMs = this.timeoutMs) {
    if (!this.overview?.capabilities?.includes("orchestration_v1")) throw new Error("Broker does not support orchestration_v1; update it before using this command");
    const requestId = randomUUID();
    const pending = this.waitFor(message => message.type === "control_response" && message.requestId === requestId, timeoutMs);
    this.send({ type: "control_request", requestId, operation, ...fields });
    const response = await pending;
    if (!response.success) throw new Error(`${response.error?.code || "failed"}: ${response.error?.message || "Control request failed"}`);
    return response.data;
  }

  async waitInput(sessionGuid, inputId) {
    const deadline = Date.now() + this.timeoutMs;
    do {
      const { input } = await this.control("get_input", { sessionGuid, inputId }, Math.max(1, deadline - Date.now()));
      if (["settled", "failed", "aborted", "unknown"].includes(input.state)) return input;
      await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
    } while (Date.now() < deadline);
    throw new Error(`Wait timed out for input ${inputId}; outcome unknown. Reconnect and wait using the same ID; do not resend.`);
  }

  async watch(sessionGuid, onEvent) {
    const listener = message => {
      if (message.type === "session_event" && message.sessionGuid === sessionGuid) onEvent(message.event);
    };
    this.listeners.add(listener);
    try {
      await this.snapshot(sessionGuid);
      // A finite observation window. Socket errors still reject immediately.
      await new Promise((resolve, reject) => {
        const finish = error => { clearTimeout(timer); this.waiters.delete(waiter); error ? reject(error) : resolve(); };
        const waiter = { predicate: () => false, reject: finish };
        const timer = setTimeout(() => finish(), this.timeoutMs);
        if (this.closed) finish(new Error("Disconnected while watching"));
        else this.waiters.add(waiter);
      });
    } finally { this.listeners.delete(listener); }
  }

  async snapshot(sessionGuid) {
    const result = this.waitFor(message => message.type === "session_snapshot" && message.session?.sessionGuid === sessionGuid);
    this.send({ type: "attach", sessionGuid });
    return (await result).session;
  }

  close() {
    this.closed = true;
    this.fail(new Error("Client closed"));
    if (this.ws) this.ws.terminate();
  }
}
