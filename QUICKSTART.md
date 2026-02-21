# Quick Start Guide

Get toilet-pi running with the web UI in under 2 minutes.

## 1. Start the Server

```bash
cd ~/Projects/toilet-pi
npm start
```

You should see:
```
============================================================
Toilet-Pi Server
============================================================
WebSocket: ws://localhost:3456
Web UI: http://localhost:3457
Authentication: Disabled
============================================================
```

Keep this terminal open.

## 2. Run pi with the Extension

In a new terminal:
```bash
pi -e ~/Projects/toilet-pi/websocket-extension.ts
```

## 3. Open the Web UI

Open your browser to:
```
http://localhost:3457
```

You should see:
- Status: Connected (green)
- Session info showing your current directory and model
- Message input field
- Send and Abort buttons

## 4. Test It

**Send a message from the web UI:**
1. Type something in the input field
2. Click Send or press Enter
3. The message appears in pi and triggers a response
4. You'll see both your message and the agent's response in the web UI

**Abort from the web UI:**
1. Start a long-running task in pi
2. Click the Abort button in the web UI
3. The operation stops immediately

## Phone Setup

### Option A: Use ngrok (easiest)

```bash
# In a new terminal
ngrok http 3457
```

Use the HTTPS URL ngrok gives you on your phone.

### Option B: Use Cloudflare tunnel

```bash
cloudflared tunnel --url http://localhost:3457
```

Use the provided URL on your phone.

### Option C: Local network only

```bash
# Find your IP
ifconfig | grep inet
```

Open your phone's browser to: `http://192.168.1.XX:3457`

## Features

- **Live conversation** - See all messages in real-time
- **Send messages** - Type and send from anywhere
- **Abort operations** - Stop whatever pi is doing with one tap
- **Mobile-first** - Optimized for phone screens
- **Auto-reconnect** - Web UI reconnects automatically if disconnected
- **Session info** - See current directory and model

## Commands in pi

- `/ws` - Show WebSocket connection status

## Security

For public access, enable authentication:

```bash
# Start server with token
TOKEN=your-secret-token npm start

# Web UI URL will be: http://localhost:3457?token=your-secret-token
```

## Troubleshooting

- **"Not connected" in web UI?** Make sure pi is running with the extension
- **Messages not appearing?** Check `/ws` in pi to verify connection
- **Need help?** See [README.md](./README.md) for detailed documentation
