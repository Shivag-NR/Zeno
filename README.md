# Chess Backend — 2 Players + 100 Read-Only Spectators

## How it works (the part that answers your question)

**The server is the only source of truth.** Neither player's client decides
what a legal move is — they just *propose* an action. The flow for every
single action is:

```
Player drags a piece
   -> client emits "make_move" {from, to}
   -> SERVER checks: are you a player? is it your turn? is this legal per
      chess.js rules?
   -> if valid: server applies it to its own Chess() instance
   -> server broadcasts "room_state" (the full board + status) to EVERY
      socket in the room — both players AND all spectators, in one shot
   -> client just renders whatever the server says is true
```

Because every participant renders the same broadcast payload, there is no
way for the two players (or any viewer) to end up seeing different states —
even under packet reordering or a slow connection, the next `room_state`
event fully resyncs a client from scratch.

**Spectators** join the exact same Socket.IO room and receive the exact
same `room_state`/`move_made` events. The only difference is authorization:
the server checks `role !== 'white' && role !== 'black'` and rejects any
`make_move` from a spectator outright — this can't be bypassed from the
client since the client has no ability to fake its own socket identity.
Room capacity is capped at 2 players + 100 spectators, enforced server-side
in `join_room`.

This generalizes to almost any turn-based board game: swap out `chess.js`
for whatever rules-engine your game needs, keep the same "propose → validate
→ broadcast" shape.

## Files

- `server.js` — Express + Socket.IO server, all game logic and authorization
- `public/index.html` — demo client (uses chessboard.js for the board UI)
- `Dockerfile` — containerizes the app for any cloud provider
- `package.json` — dependencies: express, socket.io, chess.js, uuid

## Run it locally

```bash
npm install
npm start
# open http://localhost:3000 in two browser tabs (players)
# and a few more tabs (spectators) — all tabs auto-join room "demo"
```

Open two tabs and join the same room name: the first becomes White, the
second Black, everyone after that is a spectator. Move a piece in the White
tab and watch it appear instantly in every other tab, including the
"read-only" ones (drag is disabled for spectators, and the server would
reject the move even if you forced it via devtools).

## Deploying to the cloud

### Option A — Render.com (simplest, free tier, native WebSocket support)
1. Push this folder to a GitHub repo.
2. On Render: New → Web Service → connect the repo.
3. Build command: `npm install` · Start command: `npm start`
4. Render auto-detects the port from `process.env.PORT` (already wired in
   `server.js`). Deploy — you get a public `https://your-app.onrender.com` URL.

### Option B — Fly.io (Docker-based, good free allowance)
```bash
fly launch      # detects the Dockerfile, asks a few questions
fly deploy
```
Fly's proxy supports WebSockets by default, no extra config needed.

### Option C — Any Docker host / AWS ECS / Google Cloud Run
```bash
docker build -t chess-backend .
docker run -p 3000:3000 chess-backend
```
Push the image to ECR/Artifact Registry and run it on ECS Fargate / Cloud
Run. **Important for AWS specifically:** if you put this behind an
Application Load Balancer, enable **sticky sessions** (or terminate
WebSockets on the ALB with target group stickiness) since Socket.IO clients
need to keep hitting the same backend instance for a given connection.

## Scaling beyond one instance

Right now game state lives in an in-memory `Map` inside `server.js` — fine
for one instance/process. If you deploy multiple replicas behind a load
balancer, two things break: (1) different players in the same room could
land on different instances, (2) in-memory state isn't shared.

Fix: add the Socket.IO Redis adapter (`socket.io-redis` /
`@socket.io/redis-adapter`) so `io.to(roomId).emit(...)` broadcasts across
all instances, and move the `rooms` Map into Redis (or a small Postgres
table) so any instance can look up any room's state. This is a drop-in
change — the game logic in `server.js` doesn't need to change at all, only
where `rooms` and the io adapter are backed.
