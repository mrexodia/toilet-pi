import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

export function parseServerUrl(value) {
  if (!value) throw new Error("Specify --server or TOILET_PI_CLI_SERVER (no machine config is read)");
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

export class ToiletPiClient {
  constructor({ serverUrl, token, timeoutMs = 20000 }) {
    this.serverUrl = parseServerUrl(serverUrl);
    if (!token?.trim()) throw new Error("Set TOILET_PI_ADMIN_TOKEN to the admin login secret (not a machine token)");
    this.token = token.trim();
    this.timeoutMs = timeoutMs;
    this.waiters = new Set();
    this.overview = null;
    this.closed = false;
  }

  async connect() {
    let response;
    try {
      response = await fetch(new URL("auth/login", this.serverUrl), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: this.token }), redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new Error("Login connection failed or timed out");
    } finally {
      this.token = undefined;
    }
    // Never log the request URL, response body, or cookie: these may contain secrets.
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Login failed (HTTP ${response.status}); use an admin login secret`);
    const cookies = response.headers.getSetCookie();
    const cookie = cookies.map(value => value.split(";", 1)[0]).find(value => value.startsWith("toilet-pi-admin="));
    if (!cookie) throw new Error("Login did not return an admin session cookie");
    const wsUrl = new URL("ws", this.serverUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(wsUrl, {
      headers: { Cookie: cookie, Origin: this.serverUrl.origin },
      handshakeTimeout: this.timeoutMs,
      maxPayload: 8 * 1024 * 1024,
      followRedirects: false,
    });
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
      if (message.type === "error") {
        this.fail(new Error(message.message || "Server rejected the request"));
        return;
      }
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(message)) waiter.resolve(message);
      }
    });
    this.ws.on("error", () => this.fail(new Error("WebSocket connection failed; command outcome may be unknown")));
    this.ws.on("close", () => {
      this.closed = true;
      this.fail(new Error("Disconnected; command outcome may be unknown. Inspect state before retrying."));
    });
    await ready;
    return this;
  }

  waitFor(predicate) {
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
      )), this.timeoutMs);
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
