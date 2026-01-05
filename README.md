# Toilet-Pi: Remote Control pi from the Toilet

A WebSocket client hook for pi that lets you send messages and abort operations remotely from your phone (or any WebSocket client). Perfect for when nature calls but your agent keeps running.

## 🎯 What This Does

This project gives you remote control over your pi instance:

1. **Send messages** - Inject messages into the conversation from anywhere
2. **Abort operations** - Stop whatever pi is doing instantly
3. **Full history** - Messages sent remotely are stored in the session just like normal user messages
4. **Auto-reconnect** - The hook stays connected even if the network drops

## 📋 Table of Contents

- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Message Format](#message-format)
- [Phone Setup](#phone-setup)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Advanced Usage](#advanced-usage)
- [Extending](#extending)

## 🚀 Quick Start

### Step 1: Install Dependencies

```bash
cd ~/Projects/toilet-pi
npm install
```

### Step 2: Start the WebSocket Server

```bash
npm start
```

You should see:
```
============================================================
Toilet-Pi WebSocket Server
============================================================
Running on ws://localhost:3456
Authentication: Disabled

Connect a client:
  wscat -c ws://localhost:3456

Message formats:
  {"type":"message","content":"your message"}
  {"type":"abort"}
============================================================
```

### Step 3: Run pi with the Hook

In a new terminal:

```bash
pi --hook ~/Projects/toilet-pi/websocket-hook.ts
```

You should see a notification: `Connecting to WebSocket: ws://localhost:3456`

### Step 4: Test from Another Terminal

Install `wscat` if needed: `npm install -g wscat`

```bash
wscat -c ws://localhost:3456
```

Then send a message:
```json
{"type":"message","content":"Hello from the toilet!"}
```

The message should appear in pi and trigger a response!

### Step 5: Test Abort

```json
{"type":"abort"}
```

This will stop whatever pi is doing, just like pressing Ctrl+C.

---

## 🧠 How It Works

### The Big Picture

```
Your Phone (on toilet)
    ↓
WebSocket Client App
    ↓
WebSocket Server (ws://localhost:3456)
    ↓
WebSocket Hook (running in pi)
    ↓
pi Agent
```

### Components

1. **WebSocket Server** (`websocket-server.js`)
   - Runs on your desktop machine (the same one running pi)
   - Listens for WebSocket connections on port 3456
   - Relays messages from clients to pi
   - Optional token-based authentication

2. **WebSocket Hook** (`websocket-hook.ts`)
   - Loaded when pi starts via `--hook` flag
   - Connects to the WebSocket server as a client
   - Listens for JSON messages
   - Calls pi APIs to inject messages or abort

3. **WebSocket Client** (your phone or another terminal)
   - Any WebSocket client can send messages
   - Uses JSON format: `{"type":"message","content":"..."}` or `{"type":"abort"}`

### Message Flow

When you send a message from your phone:

1. Your phone's WebSocket client sends JSON to the server
2. The server receives and relays it to pi's hook
3. The hook parses the JSON:
   - If `type: "message"`: calls `pi.sendMessage()` which:
     - Creates a `CustomMessageEntry` in the session
     - Adds it to the LLM context
     - Displays it in the TUI
     - If agent is idle, triggers a new turn
   - If `type: "abort"`: calls `ctx.abort()` which:
     - Cancels any in-progress LLM request
     - Aborts any running tool execution
     - Returns control to the user

---

## 🏗 Architecture

### Hook Lifecycle

```
pi starts
  ↓
Hook is loaded
  ↓
session_start event fires
  ↓
Hook connects to WebSocket server
  ↓
Hook waits for messages...
  ↓
Message received
  ↓
Hook calls pi.sendMessage() or ctx.abort()
  ↓
pi processes the action
  ↓
User session_shutdown
  ↓
Hook closes WebSocket connection
```

### Session Integration

Messages sent via WebSocket are **first-class citizens** in the pi session:

- Stored as `CustomMessageEntry` with `customType: "websocket-message"`
- Appear in conversation history with purple styling
- Participate in LLM context (sent to the model)
- Visible in `/tree` navigation
- Persisted across pi restarts
- Can be branched from, compacted, etc.

The only difference from a regular user message is the custom styling that identifies it as coming from the WebSocket.

---

## 📨 Message Format

All messages are JSON with a `type` field:

### Send Message

```json
{
  "type": "message",
  "content": "Run the tests again"
}
```

- `type`: Must be `"message"`
- `content`: Your message text (required)

**Behavior:**
- Message is added to the conversation
- If agent is idle, wakes it up and triggers a response
- Message is stored in the session file
- Displays in the TUI with purple styling

### Abort

```json
{
  "type": "abort"
}
```

- `type`: Must be `"abort"`
- No other fields

**Behavior:**
- Stops any in-progress LLM request
- Aborts any running tool execution
- Equivalent to pressing Ctrl+C
- Returns control to the user

---

## 📱 Phone Setup

To use this from your phone while on the toilet:

### Option 1: Local Network (at home)

1. Find your desktop's local IP address:
   ```bash
   ifconfig | grep inet
   ```
   Look for something like `192.168.1.23`

2. Start the WebSocket server (it binds to all interfaces by default):
   ```bash
   npm start
   ```

3. Connect your phone's WebSocket client to:
   ```
   ws://192.168.1.23:3456
   ```

**Limitations:**
- Only works when phone and desktop are on the same network
- Doesn't work when you're away from home

### Option 2: ngrok (easiest for public access)

1. Install ngrok:
   ```bash
   brew install ngrok
   ```

2. Run ngrok tunnel:
   ```bash
   ngrok tcp 3456
   ```

3. ngrok will give you a URL like:
   ```
   tcp://0.tcp.ngrok.io:12345
   ```

4. Connect your phone to:
   ```
   ws://0.tcp.ngrok.io:12345
   ```

**Pros:**
- Works from anywhere
- No router configuration needed
- Free tier is sufficient

**Cons:**
- URL changes each time ngkok starts
- ngrok may rate-limit free tier

### Option 3: Cloudflare Tunnel (recommended)

1. Install cloudflared:
   ```bash
   brew install cloudflared
   ```

2. Run the tunnel:
   ```bash
   cloudflared tunnel --url ws://localhost:3456
   ```

3. cloudflared will give you a URL like:
   ```
   wss://random-name.trycloudflare.com
   ```

4. Connect your phone to that URL.

**Pros:**
- Free, no account required
- Works from anywhere
- URL persists while tunnel is running
- Encrypted (WSS)

**Cons:**
- URL changes on restart (but stays same while running)

### Phone WebSocket Client Apps

**Android:**
- "Simple WebSocket Client"
- "WebSocket Client"
- Any browser-based client

**iOS:**
- "Rocket WebSocket"
- "WebSocket Terminal"
- Any browser-based client

**Browser:**
- https://www.piesocket.com/websocket-tester
- https://amritb.github.io/websocket-client/
- Any online WebSocket test tool

---

## 🔒 Security

### Authentication

The server supports token-based authentication. Without it, anyone who connects can send messages to your pi.

**Enable authentication:**

1. Set a token when starting the server:
   ```bash
   TOKEN=my-secret-token npm start
   ```

2. Clients must include the token in their connection URL:
   ```
   wscat -c "ws://localhost:3456?token=my-secret-token"
   ```

3. Invalid tokens are rejected with:
   ```json
   {"error":"Invalid token"}
   ```

**Best Practices:**
- Use a strong, random token (at least 32 characters)
- Store token in environment variable, not in code
- Rotate tokens regularly
- Never commit tokens to git

### Additional Security Measures

**For public internet access:**

1. **Always use authentication** (TOKEN)
2. **Use WSS (encrypted)**:
   - cloudflared provides WSS automatically
   - For ngrok, you'll need a paid plan for custom domains
3. **Consider IP whitelisting** if your server supports it
4. **Rate limiting** - Add to your server if needed
5. **Use a reverse proxy** with authentication (nginx, caddy)

**For local network only:**

- Still use TOKEN for basic protection
- Your network is your main security boundary
- Ensure your WiFi is secure (WPA3, strong password)

### What Can a Compromised Connection Do?

If someone connects to your WebSocket server (or guesses your token):

- Send arbitrary messages to your pi
- Abort your work in progress
- Potentially execute commands (if the message triggers tools)
- Read your session history (if you add that feature)

**This is essentially remote control of your pi.**

---

## 🔧 Troubleshooting

### Connection Issues

**Problem: "Connection refused"**

Cause: WebSocket server isn't running

Solution:
```bash
# Check if port is in use
lsof -i :3456

# Start the server
npm start
```

**Problem: "Port already in use"**

Cause: Something else is using port 3456

Solution:
```bash
# Find what's using the port
lsof -i :3456

# Kill the process or use a different port
PORT=3457 npm start
```

**Problem: Can't connect from phone**

Checklist:
- Is the server running?
- Is your desktop firewall blocking port 3456?
- Are phone and desktop on the same network (for local IP)?
- Is the tunnel service running (for ngrok/cloudflared)?
- Is the URL correct?

### Hook Issues

**Problem: Hook not connecting**

Check:
- Is pi running with `--hook` flag?
- Is the WS_URL correct? Check `/ws` command in pi
- Is the server running and accessible?

**Problem: Messages not appearing in pi**

Check:
- Run `/ws` in pi to see connection status
- Check server logs show messages being received
- Verify JSON format is correct
- Try sending a test message from wscat first

**Problem: Can't abort**

Check:
- Is pi actually doing something?
- Does regular Ctrl+C work?
- Check for error messages
- Verify message format: `{"type":"abort"}`

### Token Issues

**Problem: "Invalid token"**

Check:
- Token matches exactly between server and client
- Client includes `?token=XYZ` in connection URL
- No extra spaces in token
- Environment variable is set: `TOKEN=... npm start`

### Phone-Specific Issues

**Problem: Can't connect from phone**

- Verify phone and desktop are on same network (for local IP)
- Check if router has firewall rules blocking the port
- Try tunnel service (ngrok/cloudflared) instead
- Test with wscat from another computer first

**Problem: Connection drops**

- Check phone's WiFi connection
- Try a different WebSocket client app
- Check if tunnel service is still running
- Hook will auto-reconnect every 5 seconds

---

## 🎛 Advanced Usage

### Custom Server Port

```bash
PORT=8080 npm start
```

Then connect to `ws://localhost:8080`

### Custom WebSocket URL in Hook

```bash
PI_WS_URL=ws://my-server:8080 pi --hook ~/Projects/toilet-pi/websocket-hook.ts
```

### Running as Background Service

**Using nohup:**
```bash
nohup npm start > /tmp/toilet-pi-server.log 2>&1 &
```

**Using systemd (Linux):**
Create `/etc/systemd/system/toilet-pi.service`:
```ini
[Unit]
Description=Toilet-Pi WebSocket Server
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/home/your-user/Projects/toilet-pi
Environment="TOKEN=your-token"
ExecStart=/usr/bin/node /home/your-user/Projects/toilet-pi/websocket-server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl enable toilet-pi
sudo systemctl start toilet-pi
sudo systemctl status toilet-pi
```

### Multiple Clients

The server supports multiple connected clients. Messages sent from one client can be broadcast to others (this is enabled by default).

Useful for:
- Multiple phones sending messages
- Observing messages sent from other devices
- Collaborative remote control

### Hook Auto-Loading

Instead of using `--hook` flag every time, you can:

1. Copy hook to auto-load directory:
   ```bash
   cp ~/Projects/toilet-pi/websocket-hook.ts ~/.pi/agent/hooks/
   ```

2. The hook will load automatically when pi starts

---

## 🚀 Extending

Here are some ideas for extending this hook:

### 1. Receive pi Responses on Phone

Add to `websocket-hook.ts`:

```typescript
pi.on("turn_end", async (event, ctx) => {
  const message = event.message;
  const text = message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "response",
      content: text,
    }));
  }
});
```

### 2. Get Session History

Add message type handler:

```typescript
} else if (msg.type === "history") {
  const entries = ctx.sessionManager.getEntries();
  const history = entries.map(e => ({
    id: e.id,
    type: e.type,
    timestamp: e.timestamp,
    // ... more fields
  }));

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "history", data: history }));
  }
}
```

### 3. Branch/Switch Sessions Remotely

```typescript
} else if (msg.type === "branch") {
  const result = await ctx.branch(msg.entryId);
  if (!result.cancelled && ctx.hasUI) {
    ctx.ui.notify("Branched via WebSocket", "info");
  }
}
```

### 4. Get Session Stats

```typescript
} else if (msg.type === "stats") {
  const stats = {
    entryCount: ctx.sessionManager.getEntries().length,
    sessionId: ctx.sessionManager.getSessionId(),
    leafId: ctx.sessionManager.getLeafId(),
    // ... more stats
  };

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stats", data: stats }));
  }
}
```

### 5. Two-Way Editor Sync

Sync the pi editor with your phone:

```typescript
// Send editor content to phone on change
pi.on("...", (event, ctx) => {
  const text = ctx.ui.getEditorText();
  ws?.send(JSON.stringify({ type: "editor", content: text }));
});

// Receive editor updates from phone
} else if (msg.type === "editor") {
  ctx.ui.setEditorText(msg.content);
}
```

### 6. Custom Message Renderer

Style WebSocket messages differently:

```typescript
import { Text } from "@mariozechner/pi-tui";

pi.registerMessageRenderer("websocket-message", (message, options, theme) => {
  const icon = theme.fg("accent", "📱 ");
  const text = typeof message.content === "string"
    ? message.content
    : "[complex message]";
  return new Text(icon + theme.fg("text", text), 0, 0);
});
```

---

## 📚 Additional Resources

- **pi Documentation**: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/README.md`
- **Hooks Documentation**: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/hooks.md`
- **Hook Examples**: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/examples/hooks/`
- **WebSocket API**: https://developer.mozilla.org/en-US/docs/Web/API/WebSocket
- **ws Library**: https://github.com/websockets/ws

---

## 📄 License

MIT

---

## 💡 Usage Tips

1. **Test locally first** - Use `wscat` from another terminal before trying your phone
2. **Use authentication** - Always set TOKEN for any public access
3. **Check connection status** - Use `/ws` command in pi to verify connection
4. **Start server early** - Start the server before pi so the hook can connect immediately
5. **Monitor logs** - Keep server logs visible to see messages being sent/received
6. **Auto-load the hook** - Copy to `~/.pi/agent/hooks/` for automatic loading
7. **Use WSS for public** - Prefer encrypted connections when exposing to internet
8. **Keep tunnel running** - Use a process manager (systemd, tmux, etc.) for long-running tunnels

---

**Happy toileting!** 🚽✨
