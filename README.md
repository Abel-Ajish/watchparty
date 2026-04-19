# WatchParty 🎬

Real-time YouTube watch party app. Watch together, in perfect sync, no account needed.

## Features
- One-click room creation (no signup)
- Real-time YouTube sync via Socket.io
- Live group chat with display names
- Host controls (lock room, kick, pass crown)
- Collaborative video queue (up to 10 videos)
- Auto sync-drift correction every 30s
- Mobile responsive

## Quick Start

```bash
npm install
npm start
```

Open http://localhost:3000

For development with auto-restart:
```bash
npm run dev
```

## Deployment

### Render
1. Push this repo to GitHub
2. Go to render.com → New Web Service
3. Connect your GitHub repo
4. Build command: `npm install`
5. Start command: `node server.js`
6. Done! Your app will be live.

### Railway
1. Push to GitHub
2. Go to railway.app → New Project → Deploy from GitHub
3. Railway auto-detects Node.js — just deploy!

## Architecture
- **Server**: Express + Socket.io (Node.js)
- **State**: In-memory (RAM) — no database needed
- **Video**: YouTube IFrame Player API
- **Sync**: Server-authoritative timestamp, 30s drift correction

## How sync works
When the host plays a video, the server records `startedAt = Date.now()`.
When a late joiner connects, the server computes:
`currentTime = storedTime + (now - startedAt) / 1000`
Every 30 seconds, all clients receive a periodic sync pulse and correct drift > 3 seconds automatically.

## Room lifecycle
Rooms live in RAM. When the last person leaves, the room is cleaned up after 60 seconds.
If the server restarts, all rooms are wiped — perfect for temporary party rooms!
