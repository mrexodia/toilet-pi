import { WebSocket } from "ws";
import { buildConnectUrl, parseToiletPiInput, readToiletPiConfig } from "./toilet-pi-config.js";

const config = process.env.TOILET_PI_SERVER_URL
  ? parseToiletPiInput(process.env.TOILET_PI_SERVER_URL)
  : await readToiletPiConfig();
const SERVER_URL = config ? buildConnectUrl(config) : "ws://localhost:3457/ws";
let currentSessionGuid = null;
let shouldQuitOnOpen = false;

const ws = new WebSocket(SERVER_URL);

function isOpen() {
  return ws.readyState === WebSocket.OPEN;
}

function send(message) {
  if (!isOpen()) {
    console.log("Socket is not open yet");
    return;
  }
  ws.send(JSON.stringify(message));
}

ws.on("open", () => {
  console.log(`Connected to ${SERVER_URL}`);
  send({ type: "hello", role: "web" });
  console.log("Commands:");
  console.log("  attach <sessionGuid>");
  console.log("  input <text>");
  console.log("  abort");
  console.log("  start <hostId> <sessionGuid>");
  console.log("  new <hostId> <cwd>");
  console.log("  refresh <hostId>");
  console.log("  quit");

  if (shouldQuitOnOpen) ws.close();
});

ws.on("message", (data) => {
  try {
    const message = JSON.parse(data.toString());
    console.log(JSON.stringify(message, null, 2));
  } catch {
    console.log(data.toString());
  }
});

ws.on("close", () => {
  console.log("Disconnected");
  process.exit(0);
});

ws.on("error", (error) => {
  console.error("WebSocket error:", error);
  process.exit(1);
});

process.stdin.setEncoding("utf8");
process.stdin.on("readable", () => {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) {
    const line = chunk.trim();
    if (!line) continue;

    const [command, ...rest] = line.split(" ");
    if (command === "quit") {
      if (isOpen()) ws.close();
      else shouldQuitOnOpen = true;
      continue;
    }

    if (command === "attach") {
      currentSessionGuid = rest[0] || null;
      send({ type: "attach", sessionGuid: currentSessionGuid });
      continue;
    }

    if (command === "input") {
      if (!currentSessionGuid) {
        console.log("Attach to a session first");
        continue;
      }
      send({
        type: "input",
        sessionGuid: currentSessionGuid,
        text: rest.join(" "),
      });
      continue;
    }

    if (command === "abort") {
      if (!currentSessionGuid) {
        console.log("Attach to a session first");
        continue;
      }
      send({ type: "abort", sessionGuid: currentSessionGuid });
      continue;
    }

    if (command === "start") {
      const [hostId, sessionGuid] = rest;
      send({ type: "start_background_session", hostId, sessionGuid });
      continue;
    }

    if (command === "new") {
      const [hostId, ...cwdParts] = rest;
      send({
        type: "create_background_session",
        requestId: `cli-${Date.now()}`,
        hostId,
        cwd: cwdParts.join(" "),
      });
      continue;
    }

    if (command === "refresh") {
      const [hostId] = rest;
      send({ type: "refresh_host_sessions", hostId });
      continue;
    }

    console.log("Unknown command");
  }
});
