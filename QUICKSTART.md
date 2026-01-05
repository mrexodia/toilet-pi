# Quick Start Guide

Get toilet-pi running in under 2 minutes.

## 1. Install Dependencies

```bash
cd ~/Projects/toilet-pi
npm install
```

## 2. Start the WebSocket Server

```bash
npm start
```

Keep this terminal open.

## 3. Run pi with the Hook

Open a new terminal and run:

```bash
pi --hook ~/Projects/toilet-pi/websocket-hook.ts
```

## 4. Test It

Open another terminal and connect the test client:

```bash
npm run client
```

Try these commands:
- `message Hello from another terminal!`
- `abort`

You can also use `wscat`:

```bash
wscat -c ws://localhost:3456
# Then send: {"type":"message","content":"Testing!"}
```

## 5. Setup Your Phone

**Option A: ngrok (easiest)**
```bash
# In a new terminal
ngrok tcp 3456
```
Use the URL it gives you on your phone's WebSocket app.

**Option B: Cloudflare (recommended)**
```bash
# In a new terminal
cloudflared tunnel --url ws://localhost:3456
```
Use the URL it gives you on your phone's WebSocket app.

**Option C: Local network (at home only)**
```bash
# Find your IP
ifconfig | grep inet
```
Connect your phone to: `ws://192.168.1.XX:3456`

## That's It!

You can now control pi from your phone while on the toilet. 🚽

---

### Commands in pi

- `/ws` - Show WebSocket connection status

### Message Format

From your phone, send JSON:

**Send a message:**
```json
{"type":"message","content":"Run the tests"}
```

**Abort:**
```json
{"type":"abort"}
```

### Security Tip

For public access, use authentication:

```bash
# Start server with token
TOKEN=your-secret-token npm start

# Connect with token
wscat -c "ws://localhost:3456?token=your-secret-token"
```

### Troubleshooting

- **Can't connect?** Make sure the server is running (`npm start` in a terminal)
- **Messages not showing?** Run `/ws` in pi to check connection
- **Need help?** See [README.md](./README.md) for detailed documentation
