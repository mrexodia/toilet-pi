import { networkInterfaces } from "node:os";
import { spawn } from "node:child_process";

const DEFAULT_PORT = "3457";
const DEFAULT_HOST = "0.0.0.0";

const port = String(process.env.PORT || DEFAULT_PORT).trim() || DEFAULT_PORT;
const host = String(process.env.HOST || DEFAULT_HOST).trim() || DEFAULT_HOST;
const publicUrl =
  String(process.env.TOILET_PI_PUBLIC_URL || "").trim() ||
  buildDefaultPublicUrl(port);

const env = {
  ...process.env,
  PORT: port,
  HOST: host,
  TOILET_PI_PUBLIC_URL: publicUrl,
};

console.log(`[start:lan] HOST=${env.HOST}`);
console.log(`[start:lan] PORT=${env.PORT}`);
console.log(`[start:lan] TOILET_PI_PUBLIC_URL=${env.TOILET_PI_PUBLIC_URL}`);

const npmExecPath = String(process.env.npm_execpath || "").trim();
const command = npmExecPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const args = npmExecPath ? [npmExecPath, "start", "--prefix", "server"] : ["start", "--prefix", "server"];
const child = spawn(command, args, {
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(`[start:lan] Failed to start server: ${error.message}`);
  process.exit(1);
});

function buildDefaultPublicUrl(portValue) {
  const lanIp = detectLanIpv4();
  return `http://${lanIp || "localhost"}:${portValue}`;
}

function detectLanIpv4() {
  const interfaces = networkInterfaces();
  const candidates = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.family !== "IPv4" || entry.internal) continue;
      candidates.push(entry.address);
    }
  }

  return candidates.find(isPrivateIpv4) || candidates[0] || null;
}

function isPrivateIpv4(address) {
  if (address.startsWith("10.")) return true;
  if (address.startsWith("192.168.")) return true;
  const match = /^172\.(\d{1,3})\./.exec(address);
  if (!match) return false;
  const octet = Number.parseInt(match[1], 10);
  return Number.isInteger(octet) && octet >= 16 && octet <= 31;
}
