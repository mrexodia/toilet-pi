import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { parseServerUrl, validCookie } from "./client.js";

function validate(value) {
  if (!value || value.version !== 1 || typeof value.serverUrl !== "string" || !validCookie(value.cookie) ||
      (value.expiresAt !== undefined && (!Number.isFinite(value.expiresAt) || value.expiresAt <= 0))) {
    throw new Error("Invalid CLI auth file; run toilet-pi login again");
  }
  return { version: 1, serverUrl: parseServerUrl(value.serverUrl).href, cookie: value.cookie,
    ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}) };
}

export function createAuthStore(file = path.join(homedir(), ".pi", "agent", "toilet-pi-auth.json")) {
  file = path.resolve(file);
  async function existing() {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("CLI auth path must be a regular file, not a symlink");
      return info;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw new Error("Cannot access CLI auth file; check its location, permissions, and that it is not a symlink");
    }
  }
  return {
    path: file,
    async read() {
      if (!await existing()) return null;
      let handle;
      try {
        handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const info = await handle.stat();
        if (!info.isFile() || info.size > 65536) throw new Error("Invalid auth file");
        if (process.platform !== "win32" && ((info.mode & 0o077) || info.uid !== process.getuid())) {
          throw new Error("Unsafe permissions");
        }
        const value = JSON.parse(await handle.readFile("utf8"));
        return validate(value);
      } catch {
        throw new Error("Cannot read CLI auth file; require valid login data and owner-only permissions (chmod 600 on Unix). Run toilet-pi login again.");
      } finally { await handle?.close(); }
    },
    async write(value) {
      const record = validate({ ...value, version: 1 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      let handle;
      try {
        await existing();
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(JSON.stringify(record, null, 2) + "\n");
        await handle.sync();
        await handle.close(); handle = null;
        await existing();
        await rename(temporary, file);
      } catch {
        throw new Error("Could not save CLI login; check the auth directory permissions and path");
      } finally {
        await handle?.close();
        await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw new Error("Could not clean up temporary CLI auth file"); });
      }
    },
    async clear(serverUrl) {
      if (!await existing()) return false;
      if (serverUrl && (await this.read()).serverUrl !== parseServerUrl(serverUrl).href) {
        throw new Error("Saved login belongs to a different server; nothing was removed");
      }
      try { await unlink(file); } catch { throw new Error("Could not remove CLI auth file"); }
      return true;
    },
  };
}

/** No saved credentials are sent to an explicitly selected different server. */
export async function resolveCredentials({ serverUrl, token, orchestratorToken }, store) {
  if (token?.trim() || orchestratorToken?.trim()) return { serverUrl, token, orchestratorToken };
  const saved = await store.read();
  if (!saved) throw new Error("Not logged in; run toilet-pi login --server URL (or supply environment credentials)");
  const selected = serverUrl ? parseServerUrl(serverUrl).href : saved.serverUrl;
  if (selected !== saved.serverUrl) throw new Error("Saved login belongs to a different server; run toilet-pi login --server URL for this server");
  if (saved.expiresAt !== undefined && saved.expiresAt <= Date.now()) throw new Error("Saved login expired; run toilet-pi login again");
  return { serverUrl: selected, sessionCookie: saved.cookie };
}

/** Hidden, bounded token entry. No echo/masking, shell arguments, or history. */
export async function promptLogin(label, { secret = false, input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY || !output.isTTY) throw new Error("Login requires an interactive terminal; alternatively supply --server and TOILET_PI_ADMIN_TOKEN");
  if (!secret) {
    const rl = createInterface({ input, output, terminal: true });
    try {
      return await new Promise((resolve, reject) => {
        rl.once("SIGINT", () => reject(new Error("Login cancelled")));
        rl.once("close", () => reject(new Error("Login cancelled")));
        rl.question(label, answer => resolve(answer.trim()));
      });
    } finally { rl.close(); }
  }
  return new Promise((resolve, reject) => {
    const wasRaw = !!input.isRaw;
    const wasFlowing = input.readableFlowing === true;
    let value = "", finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGINT", onSignal);
      input.setRawMode(wasRaw);
      if (!wasFlowing) input.pause();
      output.write("\n");
      error ? reject(error) : resolve(value.trim());
    };
    const onEnd = () => finish(new Error("Login cancelled"));
    const onError = () => finish(new Error("Token input failed"));
    const onSignal = () => finish(new Error("Login cancelled"));
    const onData = data => {
      for (const ch of String(data)) {
        if (ch === "\u0003" || ch === "\u0004") return onEnd();
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\b" || ch === "\u007f") value = value.slice(0, -1);
        else if (ch >= " " && ch <= "~") value += ch;
        else return finish(new Error("Token contains unsupported control characters"));
        if (value.length > 32768) return finish(new Error("Token is too long"));
      }
    };
    output.write(label);
    input.setRawMode(true);
    input.on("data", onData); input.once("end", onEnd); input.once("error", onError);
    process.once("SIGTERM", onSignal); process.once("SIGINT", onSignal);
    input.resume();
  });
}
