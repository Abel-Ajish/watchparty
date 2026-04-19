const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { nanoid } = require('nanoid');

// --- Vigorous Data Handling & Validation ---
const isValidRoomId = (id) => typeof id === 'string' && id.length > 0 && id.length < 50;
const isValidName = (name) => typeof name === 'string' && name.length > 0 && name.length <= 24;
const isValidVideoId = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(id);
const isValidUrl = (url) => typeof url === 'string' && url.length < 500;
const sanitize = (str) => typeof str === 'string' ? str.replace(/[<>]/g, '') : '';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// In-memory room state
const rooms = {};

// Clean up empty rooms every hour
setInterval(() => {
  const now = Date.now();
  Object.keys(rooms).forEach(roomId => {
    const room = rooms[roomId];
    if (Object.keys(room.participants).length === 0) {
      // If room has been empty for more than 30 mins, delete it
      if (room.emptySince && (now - room.emptySince > 30 * 60 * 1000)) {
        delete rooms[roomId];
      } else if (!room.emptySince) {
        room.emptySince = now;
      }
    } else {
      room.emptySince = null;
    }
  });
}, 15 * 60 * 1000);

function getOrCreateRoom(roomId) {
  if (!roomId) return null;
  if (!rooms[roomId]) {
    rooms[roomId] = {
      id: roomId,
      host: null,
      videoId: null,
      videoTitle: null,
      videoThumb: null,
      playing: false,
      currentTime: 0,
      startedAt: null, // server timestamp when play was pressed
      queue: [],
      participants: {},
      messages: [],
      locked: false,
      emptySince: null,
    };
  }
  return rooms[roomId];
}

function getGlobalTime(room) {
  if (!room.playing || room.startedAt === null) return room.currentTime;
  const elapsed = (Date.now() - room.startedAt) / 1000;
  return room.currentTime + elapsed;
}

const ADJECTIVES = ['Cosmic','Velvet','Neon','Shadow','Thunder','Phantom','Crystal','Ember','Mystic','Solar'];
const ANIMALS = ['Panda','Falcon','Otter','Tiger','Fox','Raven','Wolf','Lynx','Hawk','Manta'];
function randomName() {
  return `${ADJECTIVES[Math.floor(Math.random()*10)]} ${ANIMALS[Math.floor(Math.random()*10)]}`;
}

// Single periodic sync interval for all rooms
setInterval(() => {
  Object.keys(rooms).forEach(roomId => {
    const room = rooms[roomId];
    if (room.playing && Object.keys(room.participants).length > 0) {
      io.to(roomId).emit('periodic-sync', {
        currentTime: getGlobalTime(room),
        playing: room.playing,
      });
    }
  });
}, 60000);

io.on('connection', (socket) => {
  let currentRoom = null;
  let userId = nanoid(8);

  // Join room
  socket.on('join-room', ({ roomId, displayName }) => {
    try {
      if (!isValidRoomId(roomId)) throw new Error('Invalid room ID');
      
      const room = getOrCreateRoom(roomId);
      if (!room) return;
      
      currentRoom = roomId;
      let name = sanitize(displayName);
      if (name && !isValidName(name)) name = randomName();
      if (!name) name = randomName();

      // First person is host
      const isHost = Object.keys(room.participants).length === 0;
      if (isHost) {
        room.host = userId;
        room.emptySince = null;
      }

      room.participants[userId] = { id: userId, name, isHost };
      socket.join(roomId);

      // Send room state to new joiner
      socket.emit('room-state', {
        ...room,
        currentTime: getGlobalTime(room),
        userId,
        participants: Object.values(room.participants),
      });

      // Notify others
      io.to(roomId).emit('participant-update', Object.values(room.participants));
      io.to(roomId).emit('chat-message', {
        id: nanoid(6),
        system: true,
        text: `${name} joined the room`,
        ts: Date.now(),
      });
    } catch (err) {
      console.error('Error in join-room:', err);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  // Helper to check if user can perform action
  const canPerformAction = (room) => {
    if (!room) return false;
    if (room.locked && room.host !== userId) return false;
    return true;
  };

  // Load video
  socket.on('load-video', ({ roomId, videoId, title, thumb }) => {
    const room = rooms[roomId];
    if (!canPerformAction(room)) return;
    if (!isValidVideoId(videoId)) return;

    room.videoId = videoId;
    room.videoTitle = sanitize(title);
    room.videoThumb = sanitize(thumb);
    room.playing = false;
    room.currentTime = 0;
    room.startedAt = null;

    io.to(roomId).emit('video-loaded', { videoId, title: room.videoTitle, thumb: room.videoThumb });
  });

  // Play
  socket.on('play-video', ({ roomId, currentTime }) => {
    const room = rooms[roomId];
    if (!canPerformAction(room)) return;
    const time = parseFloat(currentTime) || 0;
    room.playing = true;
    room.currentTime = time;
    room.startedAt = Date.now();
    io.to(roomId).emit('video-play', { currentTime: time, serverTime: Date.now() });
  });

  // Pause
  socket.on('pause-video', ({ roomId, currentTime }) => {
    const room = rooms[roomId];
    if (!canPerformAction(room)) return;
    const time = parseFloat(currentTime) || 0;
    room.playing = false;
    room.currentTime = time;
    room.startedAt = null;
    io.to(roomId).emit('video-pause', { currentTime: time });
  });

  // Seek
  socket.on('seek-video', ({ roomId, currentTime }) => {
    const room = rooms[roomId];
    if (!canPerformAction(room)) return;
    const time = parseFloat(currentTime) || 0;
    room.currentTime = time;
    if (room.playing) room.startedAt = Date.now();
    io.to(roomId).emit('video-seek', { currentTime: time });
  });

  // Chat
  socket.on('chat-message', ({ roomId, text }) => {
    const room = rooms[roomId];
    if (!room || !room.participants[userId]) return;
    const cleanText = sanitize(text).trim();
    if (!cleanText || cleanText.length > 300) return;

    const msg = {
      id: nanoid(6),
      userId,
      name: room.participants[userId].name,
      text: cleanText,
      ts: Date.now(),
    };
    room.messages.push(msg);
    if (room.messages.length > 200) room.messages.shift();
    io.to(roomId).emit('chat-message', msg);
  });

  // Queue: add
  socket.on('queue-add', ({ roomId, videoId, title, thumb }) => {
    const room = rooms[roomId];
    if (!canPerformAction(room)) return;
    if (room.queue.length >= 10) return;
    if (!isValidVideoId(videoId)) return;

    room.queue.push({ 
      videoId, 
      title: sanitize(title), 
      thumb: sanitize(thumb), 
      id: nanoid(6) 
    });
    io.to(roomId).emit('queue-update', room.queue);
  });

  // Queue: play next
  socket.on('queue-next', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.host !== userId) return;
    const next = room.queue.shift();
    if (next) {
      room.videoId = next.videoId;
      room.videoTitle = next.title;
      room.videoThumb = next.thumb;
      room.playing = false;
      room.currentTime = 0;
      room.startedAt = null;
      io.to(roomId).emit('video-loaded', { videoId: next.videoId, title: next.title, thumb: next.thumb });
      io.to(roomId).emit('queue-update', room.queue);
    }
  });

  // Queue: remove
  socket.on('queue-remove', ({ roomId, queueId }) => {
    const room = rooms[roomId];
    if (!room || room.host !== userId) return;
    room.queue = room.queue.filter(q => q.id !== queueId);
    io.to(roomId).emit('queue-update', room.queue);
  });

  // Sync request
  socket.on('request-sync', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    socket.emit('force-sync', {
      currentTime: getGlobalTime(room),
      playing: room.playing,
      videoId: room.videoId,
    });
  });

  // Host: lock room
  socket.on('toggle-lock', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.host !== userId) return;
    room.locked = !room.locked;
    io.to(roomId).emit('room-locked', room.locked);
  });

  // Host: kick user
  socket.on('kick-user', ({ roomId, targetId }) => {
    const room = rooms[roomId];
    if (!room || room.host !== userId) return;
    io.to(roomId).emit('user-kicked', { targetId, name: room.participants[targetId]?.name });
  });

  // Host: pass crown
  socket.on('pass-crown', ({ roomId, targetId }) => {
    const room = rooms[roomId];
    if (!room || room.host !== userId) return;
    room.host = targetId;
    if (room.participants[userId]) room.participants[userId].isHost = false;
    if (room.participants[targetId]) room.participants[targetId].isHost = true;
    io.to(roomId).emit('host-changed', { newHostId: targetId });
    io.to(roomId).emit('participant-update', Object.values(room.participants));
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const name = room.participants[userId]?.name;
    delete room.participants[userId];

    // If host left, assign new host
    if (room.host === userId) {
      const remaining = Object.keys(room.participants);
      if (remaining.length > 0) {
        room.host = remaining[0];
        room.participants[remaining[0]].isHost = true;
        io.to(currentRoom).emit('host-changed', { newHostId: remaining[0] });
      }
    }

    const participantsArr = Object.values(room.participants);
    if (participantsArr.length === 0) {
      room.emptySince = Date.now();
    }

    io.to(currentRoom).emit('participant-update', participantsArr);
    if (name) {
      io.to(currentRoom).emit('chat-message', {
        id: nanoid(6),
        system: true,
        text: `${name} left the room`,
        ts: Date.now(),
      });
    }
  });
});

// API: create room
app.get('/api/create-room', (req, res) => {
  try {
    const roomId = `${nanoid(4)}-${nanoid(4)}-${nanoid(4)}`;
    res.json({ roomId });
  } catch (err) {
    console.error('API Error:', err);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// Global Error Handler for Express
app.use((err, req, res, next) => {
  console.error('Unhandled Express Error:', err);
  res.status(500).send('Something went wrong on the server.');
});

// Prevent server from crashing on unhandled rejections/exceptions
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  // Give the server a second to log before potentially exiting
  setTimeout(() => {
    if (process.env.NODE_ENV === 'production') {
      // On Render, we might want to exit and let the service restart
      process.exit(1);
    }
  }, 1000);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`WatchParty running on http://localhost:${PORT}`));
