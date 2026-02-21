# Toilet-Pi: Remote Control pi from the Toilet

A WebSocket extension + web UI for pi that lets you monitor conversations, send messages, and abort operations remotely from your phone (or any browser). Perfect for when nature calls.

## 🎯 What This Does

This project gives you full remote control and visibility of your pi session:

- **Live conversation feed** - See all messages in real-time
- **Send messages** - Type messages that appear as if you typed them directly
- **Abort operations** - Stop whatever pi is doing instantly
- **Mobile-first web UI** - Optimized for phone screens
- **In-memory session tracking** - No disk persistence, just works

## 📋 Table of Contents

- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Web UI Features](#web-ui-features)
- [Phone Setup](#phone-setup)
- [Security](#security)
- [Troubleshooting](#troubleshooting)

## 🚀 Quick Start

### Step 1: Install Dependencies

```bash
cd ~/Projects/toilet-pi
npm install
```

### Step 2: Start the Server

```bash
npm start
```

Keep this terminal open. You should see:
```
============================================================
Toilet-Pi Server
============================================================
WebSocket: ws://localhost:3456
Web UI: http://localhost:3457
============================================================
```

### Step 3: Run pi with the Extension

In a new terminal:
```bash
pi -e ~/Projects/toilet-pi/websocket-extension.ts
```

### Step 4: Open the Web UI

Open your browser to:
```
http://localhost:3457
```

### Step 5: Test It

- Type a message in the web UI and click Send - it appears in pi
- Start a long task in pi, then click Abort in the web UI - it stops immediately

---

## 🧠 How It Works

### The Big Picture

```
Phone Browser (web UI)
    ↓
HTTP/WebSocket Server (port 3457/3456)
    ↓
pi Extension (running in pi)
    ↓
pi Agent
```

### Components

1. **Server** (`websocket-server.js`)
   - Runs on your desktop (same machine as pi)
   - WebSocket server on port 3456 for extension connections
   - HTTP server on port 3457 serving the web UI
   - Tracks sessions in memory (no disk persistence)
   - Broadcasts messages to web UI clients
   - Forwards web UI commands (message/abort) to extension

2. **Extension** (`websocket-extension.ts`)
   - Loaded when pi starts via `-e` flag
   - Connects to WebSocket server
   - Sends session_start event when connected
   - Forwards all messages (user, assistant, tool results) to server
   - Receives message/abort commands from server and executes them

3. **Web UI** (embedded in server)
   - Mobile-first responsive design
   - Real-time message feed
   - Message input field
   - Abort button
   - Auto-reconnect on disconnect
   - Shows session info (directory, model)

### Message Flow

**From pi to phone:**
1. Agent sends a message (user, assistant, or tool result)
2. Extension catches the event (turn_end or tool_result)
3. Extension forwards to server via WebSocket
4. Server stores in memory and broadcasts to web UI
5. Web UI displays the message

**From phone to pi:**
1. User types message or clicks Abort in web UI
2. Web UI sends to server via WebSocket
3. Server forwards to extension via WebSocket
4. Extension calls pi API (sendMessage or ctx.abort)
5. pi executes the action

---

## 🏗 Architecture

### Server Architecture

```
Server Process
├── WebSocket Server (port 3456)
│   ├── Extension clients (pi connections)
│   └── Web UI clients (browser connections)
├── HTTP Server (port 3457)
│   └── Serves web UI HTML/JS/CSS
└── In-Memory Storage
    └── sessions Map: sessionId → {
        messages: [],
        connected: boolean,
        cwd: string,
        model: string
      }
```

### Extension Event Flow

```
pi starts
  ↓
Extension loaded
  ↓
session_start event
  ↓
Extension connects to server
  ↓
Extension sends session_start (with sessionId, cwd, model)
  ↓
Extension sends existing messages from session
  ↓
turn_end event → Extension forwards to server → Server broadcasts to web UI
tool_result event → Extension forwards to server → Server broadcasts to web UI
  ↓
Web UI sends message → Server → Extension → pi.sendMessage()
Web UI sends abort → Server → Extension → ctx.abort()
```

---

## 🎨 Web UI Features

### Message Display

- **User messages** - Blue, right-aligned (like you typed them)
- **Assistant messages** - Dark gray, left-aligned
- **Tool results** - Purple left border, left-aligned
- **Errors** - Red left border, left-aligned
- **Timestamps** - Small, gray text above each message

### Controls

- **Message input** - Text field with autocomplete disabled
- **Send button** - Green, disabled when disconnected
- **Abort button** - Red, disabled when disconnected
- **Send on Enter** - Press Enter in input to send

### Status

- **Connection status** - Green "Connected" or red "Disconnected"
- **Session info** - Current working directory and model name
- **Auto-reconnect** - Web UI reconnects automatically every 3 seconds

### Mobile Optimization

- Full-height layout (no browser chrome)
- Touch-friendly buttons
- Large tap targets
- Auto-scroll to newest messages
- No zoom on focus (viewport meta tag)

---

## 📱 Phone Setup

To use the web UI from your phone while on the toilet:

### Option 1: ngrok (easiest)

1. Install ngrok:
   ```bash
   brew install ngrok
   ```

2. Run ngrok tunnel:
   ```bash
   ngrok http 3457
   ```

3. ngrok gives you a URL like:
   ```
   https://a1b2c3d4.ngrok-free.app
   ```

4. Open that URL on your phone

**Pros:**
- Works from anywhere
- HTTPS by default
- No router configuration

**Cons:**
- URL changes on each ngrok restart

### Option 2: Cloudflare Tunnel (recommended)

1. Install cloudflared:
   ```bash
   brew install cloudflared
   ```

2. Run the tunnel:
   ```bash
   cloudflared tunnel --url http://localhost:3457
   ```

3. Get the URL like:
   ```
   https://random-name.trycloudflare.com
   ```

4. Open on your phone

**Pros:**
- Free, no account required
- HTTPS by default
- Works from anywhere

**Cons:**
- URL changes on restart

### Option 3: Local Network (at home only)

1. Find your desktop's IP:
   ```bash
   ifconfig | grep inet
   ```
   Look for something like `192.168.1.23`

2. Open your phone's browser to:
   ```
   http://192.168.1.23:3457
   ```

**Pros:**
- No external service needed
- Private to your network

**Cons:**
- Only works when phone and desktop are on same network
- No HTTPS (HTTP only)

---

## 🔒 Security

### Authentication

The server supports token-based authentication. Without it, anyone who can access your web UI can control your pi.

**Enable authentication:**

```bash
TOKEN=your-secret-token npm start
```

Then access the web UI with:
```
http://localhost:3457?token=your-secret-token
```

**For public internet access:**

1. **Always use TOKEN** - Set a strong, random token
2. **Use HTTPS** - ngrok or cloudflared provide HTTPS automatically
3. **Rotate tokens** - Change tokens regularly
4. **Use a tunnel service** - Don't expose ports directly

**Best Practices:**

- Generate a random token: `openssl rand -hex 32`
- Store token in environment variable, not in code
- Don't share URLs with tokens
- Use VPN or firewall if possible

### What Can a Compromised Access Do?

If someone accesses your web UI:

- See your entire conversation history
- Send arbitrary messages to pi
- Abort your work in progress
- Potentially execute commands (if messages trigger tools)

**This is essentially remote control of your pi.**

---

## 🔧 Troubleshooting

### Connection Issues

**Problem: "Not connected" in web UI**

Checklist:
- Is the server running? (`npm start`)
- Is pi running with the extension? (`pi -e ...`)
- Try `/ws` command in pi to check connection
- Check browser console for errors

**Problem: Messages not appearing**

Checklist:
- Is pi actually generating messages?
- Try sending a message from the web UI first
- Check `/ws` in pi to verify connection
- Refresh the web UI page

**Problem: Can't connect from phone**

Checklist:
- Is the tunnel service running (ngrok/cloudflared)?
- Is the URL correct?
- Are phone and desktop on same network (for local IP)?
- Try opening the URL on your desktop first

### Extension Issues

**Problem: Extension shows "retry X" forever**

- Make sure server is running
- Check the port (default 3456) isn't blocked
- Try restarting pi

**Problem: Messages from web UI don't reach pi**

- Try `/ws` command to check connection status
- Check server logs show messages being received
- Verify JSON format is correct

### Server Issues

**Problem: Port already in use**

```bash
# Find what's using the port
lsof -i :3456
lsof -i :3457

# Kill the process or use different ports
WS_PORT=3458 HTTP_PORT=3459 npm start
```

**Problem: Server crashes on Ctrl+C**

- Should shutdown cleanly now
- Check for zombie processes: `ps aux | grep node`

---

## 🛠 Configuration

### Ports

Default ports:
- WebSocket (extension): 3456
- HTTP (web UI): 3457

Custom ports:
```bash
WS_PORT=3458 HTTP_PORT=3459 npm start
```

Then update the extension to match:
```bash
PI_WS_URL=ws://localhost:3458 pi -e ~/Projects/toilet-pi/websocket-extension.ts
```

### Authentication Token

```bash
TOKEN=your-secret-token npm start
```

Web UI URL includes token:
```
http://localhost:3457?token=your-secret-token
```

---

## 📚 Session Information

The web UI shows:
- **Current working directory** - Where pi is running
- **Model name** - Which LLM model is active
- **Connection status** - Green if connected, red otherwise

---

## 🎯 Use Cases

- **Monitor long-running jobs** - Watch progress from anywhere
- **Send quick updates** - "Stop and run tests instead"
- **Emergency abort** - Something went wrong, stop immediately
- **Collaborative debugging** - Multiple people can watch the session
- **Toilet productivity** - Stay productive anywhere

---

## 📄 License

MIT

---

## 💡 Tips

1. **Test locally first** - Open web UI on your desktop before trying your phone
2. **Use authentication** - Always set TOKEN for any public access
3. **Keep server running** - Use a process manager (tmux, screen) for long sessions
4. **Monitor connection** - Use `/ws` command in pi to check status
5. **Refresh if stuck** - Reload the web UI page if messages stop appearing
6. **Auto-load the extension** - Copy to `~/.pi/agent/extensions/` for automatic loading

---

**Happy toileting! 🚽✨**
