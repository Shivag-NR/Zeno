/**
 * Authoritative real-time chess backend.
 *
 * Core idea: the SERVER owns the game state (via chess.js). Clients never
 * decide what happened — they only propose actions ("I want to move e2-e4").
 * The server validates, applies, and then broadcasts the resulting state to
 * every socket in the room (both players + all spectators) in one shot.
 * That single broadcast is what guarantees both players and every viewer
 * see an identical, consistent board at all times.
 *
 * Roles:
 *  - player  (white/black): the only role allowed to send "make_move"
 *  - spectator: receives every state update, cannot mutate anything.
 *    Up to 100 per room, enforced server-side.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // tighten this to your real frontend origin in production
});

const PORT = process.env.PORT || 3000;
const MAX_SPECTATORS = 100;

app.use(express.static(path.join(__dirname, 'public')));

/**
 * In-memory room store.
 * For production / multi-instance scaling, replace this Map with Redis
 * (see README "Scaling beyond one instance" section) and use the
 * socket.io-redis adapter so all instances share room broadcasts.
 */
const rooms = new Map();
// room = {
//   id, game: Chess,
//   players: { white: socketId|null, black: socketId|null },
//   names:   { white: string|null, black: string|null },
//   spectators: Map<socketId, name>,
//   createdAt
// }

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      game: new Chess(),
      players: { white: null, black: null },
      names: { white: null, black: null },
      spectators: new Map(),
      createdAt: Date.now()
    });
  }
  return rooms.get(roomId);
}

function roleOfSocket(room, socketId) {
  if (room.players.white === socketId) return 'white';
  if (room.players.black === socketId) return 'black';
  if (room.spectators.has(socketId)) return 'spectator';
  return null;
}

function gameStatus(game) {
  return {
    isOver: game.isGameOver(),
    isCheckmate: game.isCheckmate(),
    isDraw: game.isDraw(),
    isStalemate: game.isStalemate(),
    isCheck: game.isCheck(),
    turn: game.turn() === 'w' ? 'white' : 'black'
  };
}

/** The single canonical snapshot sent to EVERY participant in the room. */
function buildStatePayload(room) {
  return {
    roomId: room.id,
    fen: room.game.fen(),
    pgn: room.game.pgn(),
    history: room.game.history({ verbose: true }).map(m => ({
      san: m.san, from: m.from, to: m.to, color: m.color, piece: m.piece,
      captured: m.captured || null, promotion: m.promotion || null
    })),
    players: {
      white: room.names.white,
      black: room.names.black
    },
    spectatorCount: room.spectators.size,
    maxSpectators: MAX_SPECTATORS,
    status: gameStatus(room.game)
  };
}

function broadcastRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit('room_state', buildStatePayload(room));
}

io.on('connection', (socket) => {

  socket.on('join_room', ({ roomId, name }) => {
    const rid = (roomId || 'demo').trim() || 'demo';
    const displayName = (name || `Guest-${socket.id.slice(0, 4)}`).slice(0, 30);
    const room = getOrCreateRoom(rid);

    socket.join(rid);
    socket.data.roomId = rid;

    let assignedRole;
    if (!room.players.white) {
      room.players.white = socket.id;
      room.names.white = displayName;
      assignedRole = 'white';
    } else if (!room.players.black) {
      room.players.black = socket.id;
      room.names.black = displayName;
      assignedRole = 'black';
    } else if (room.spectators.size < MAX_SPECTATORS) {
      room.spectators.set(socket.id, displayName);
      assignedRole = 'spectator';
    } else {
      socket.emit('join_rejected', { reason: 'Room full: 2 players + 100 spectators already present.' });
      return;
    }

    socket.data.role = assignedRole;

    socket.emit('role_assigned', {
      role: assignedRole,
      roomId: rid,
      youAre: displayName
    });

    // Everyone in the room — both players and every spectator — gets the
    // same authoritative snapshot the instant membership changes.
    broadcastRoomState(rid);
  });

  socket.on('make_move', ({ from, to, promotion }) => {
    const rid = socket.data.roomId;
    const room = rid && rooms.get(rid);
    if (!room) {
      socket.emit('move_rejected', { reason: 'Not in a room.' });
      return;
    }

    const role = roleOfSocket(room, socket.id);

    // --- Authorization: only players may act, spectators never can ---
    if (role !== 'white' && role !== 'black') {
      socket.emit('move_rejected', { reason: 'Spectators are not authorized to make moves.' });
      return;
    }

    // --- Turn enforcement: it must actually be this player's turn ---
    const turnColor = room.game.turn() === 'w' ? 'white' : 'black';
    if (role !== turnColor) {
      socket.emit('move_rejected', { reason: `It is ${turnColor}'s turn, not yours.` });
      return;
    }

    // --- Rule validation happens ONLY on the server, via chess.js ---
    let moveResult;
    try {
      moveResult = room.game.move({ from, to, promotion: promotion || 'q' });
    } catch (err) {
      moveResult = null;
    }

    if (!moveResult) {
      socket.emit('move_rejected', { reason: 'Illegal move.' });
      return;
    }

    // Move accepted. Broadcast the new authoritative state to the whole
    // room — this is the mechanism that keeps both players AND every
    // spectator in perfect sync on every single action.
    io.to(rid).emit('move_made', {
      by: role,
      san: moveResult.san,
      from: moveResult.from,
      to: moveResult.to
    });
    broadcastRoomState(rid);
  });

  socket.on('disconnect', () => {
    const rid = socket.data.roomId;
    const room = rid && rooms.get(rid);
    if (!room) return;

    if (room.players.white === socket.id) {
      room.players.white = null;
      room.names.white = null;
    } else if (room.players.black === socket.id) {
      room.players.black = null;
      room.names.black = null;
    } else {
      room.spectators.delete(socket.id);
    }

    broadcastRoomState(rid);

    // Clean up empty, inactive rooms so memory doesn't grow unbounded.
    const isEmpty = !room.players.white && !room.players.black && room.spectators.size === 0;
    if (isEmpty) rooms.delete(rid);
  });
});

app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

server.listen(PORT, () => {
  console.log(`Chess backend listening on port ${PORT}`);
});
