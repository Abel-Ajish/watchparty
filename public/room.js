// ── State ─────────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const ROOM_ID = params.get('room');
if (!ROOM_ID) location.href = '/';

let socket;
let player;
let ytReady = false;
let myUserId = null;
let myName = null;
let isHost = false;
let hostId = null;
let isPlaying = false;
let ignoreEvents = false; // prevent feedback loops
let roomLocked = false;
let participants = {};
let queue = [];
let currentVideoId = null;
let pendingVideoId = null; // load after YT ready

// ── YouTube API Ready ─────────────────────────────────────────────────────
window.onYouTubeIframeAPIReady = () => {
  ytReady = true;
  if (pendingVideoId) {
    loadYTVideo(pendingVideoId);
    pendingVideoId = null;
  }
};

function loadYTVideo(videoId, startSeconds = 0) {
  currentVideoId = videoId;
  const placeholder = document.getElementById('player-placeholder');
  if (placeholder) placeholder.style.display = 'none';
  
  // Update fallback link
  const fbBtn = document.getElementById('yt-fallback-btn');
  if (fbBtn) fbBtn.href = `https://www.youtube.com/watch?v=${videoId}`;

  if (!player) {
    // The simple origin is often the most compatible for mobile
    const origin = window.location.protocol + '//' + window.location.hostname + (window.location.port ? ':' + window.location.port : '');
    
    player = new YT.Player('player', {
      videoId,
      playerVars: {
        autoplay: 1, 
        controls: 1,
        rel: 0,
        modestbranding: 1,
        playsinline: 1, 
        origin: origin,
        enablejsapi: 1,
        start: Math.floor(startSeconds),
      },
      events: {
        onReady: (e) => {
          if (startSeconds > 0) e.target.seekTo(startSeconds, true);
        },
        onStateChange: onPlayerStateChange,
        onError: (e) => {
          console.error('YT Player Error:', e.data);
          let msg = 'An error occurred with the YouTube player.';
          if (e.data === 2) msg = 'Invalid video ID.';
          if (e.data === 5) msg = 'Player error.';
          if (e.data === 100) msg = 'Video not found or removed.';
          if (e.data === 101 || e.data === 150) {
            msg = 'Embedding disabled for this video.';
            // If embedding is disabled, show a specialized toast with the YouTube link
            showToast('Embedding disabled by owner. Try another video or open in YouTube.', 'error');
            return;
          }
          showToast(msg, 'error');
        }
      },
    });
  } else {
    player.loadVideoById({ videoId, startSeconds: Math.floor(startSeconds) });
  }
}

function rebuildPlayer() {
  if (player) {
    try {
      player.destroy();
    } catch (e) {
      console.error('Error destroying player:', e);
    }
    player = null;
  }
  
  // Re-create the div because destroy() removes it
  const wrap = document.querySelector('.video-wrap');
  if (!wrap.querySelector('#player')) {
    const pDiv = document.createElement('div');
    pDiv.id = 'player';
    wrap.appendChild(pDiv);
  }
  
  if (currentVideoId) {
    loadYTVideo(currentVideoId, player?.getCurrentTime() || 0);
    showToast('Attempting to fix player...', 'success');
  } else {
    showToast('No video to fix.', 'error');
  }
}

function onPlayerStateChange(e) {
  if (ignoreEvents) return;
  const t = player.getCurrentTime();
  if (e.data === YT.PlayerState.PLAYING) {
    isPlaying = true;
    updatePlayPauseIcon(true);
    socket.emit('play-video', { roomId: ROOM_ID, currentTime: t });
  } else if (e.data === YT.PlayerState.PAUSED) {
    isPlaying = false;
    updatePlayPauseIcon(false);
    socket.emit('pause-video', { roomId: ROOM_ID, currentTime: t });
  } else if (e.data === YT.PlayerState.ENDED) {
    if (isHost && queue.length > 0) {
      socket.emit('queue-next', { roomId: ROOM_ID });
    }
    updatePlayPauseIcon(false);
  }
}

function updatePlayPauseIcon(playing) {
  document.getElementById('play-icon').style.display = playing ? 'none' : '';
  document.getElementById('pause-icon').style.display = playing ? '' : 'none';
}

// ── Socket Setup ──────────────────────────────────────────────────────────
socket = io();

socket.on('connect', () => {
  // Wait for name from modal
  console.log('Connected to server');
});

socket.on('disconnect', (reason) => {
  console.warn('Disconnected:', reason);
  if (reason === 'io server disconnect') {
    // the disconnection was initiated by the server, you need to reconnect manually
    socket.connect();
  }
  showToast('Connection lost. Reconnecting...', 'error');
});

socket.on('reconnect', (attemptNumber) => {
  showToast('Reconnected to server!', 'success');
});

socket.on('reconnect_error', (err) => {
  console.error('Reconnection error:', err);
});

socket.on('connect_error', (err) => {
  console.error('Connection error:', err);
  showToast('Failed to connect to server', 'error');
});

socket.on('error', (err) => {
  showToast(err.message || 'An error occurred', 'error');
});

socket.on('room-state', (state) => {
  myUserId = state.userId;
  hostId = state.host;
  isHost = hostId === myUserId;
  roomLocked = state.locked;
  participants = {};
  state.participants.forEach(p => participants[p.id] = p);
  queue = state.queue || [];

  document.getElementById('room-id-display').textContent = `room/${ROOM_ID}`;
  document.title = `Room ${ROOM_ID} — WatchParty`;
  document.getElementById('q-count-tab').textContent = queue.length;
  updateLockUI();
  renderParticipants();
  renderQueue();

  if (state.videoId) {
    document.getElementById('now-playing').style.display = '';
    document.getElementById('controls-bar').style.display = 'flex';
    document.getElementById('video-title-sidebar').textContent = state.videoTitle || '';
    document.getElementById('add-queue-btn').style.display = '';
    if (ytReady) {
      loadYTVideo(state.videoId, state.currentTime || 0);
      if (state.playing) {
        setTimeout(() => {
          ignoreEvents = true;
          player?.playVideo();
          setTimeout(() => ignoreEvents = false, 500);
        }, 800);
      }
    } else {
      pendingVideoId = state.videoId;
    }
  }
});

socket.on('video-loaded', ({ videoId, title, thumb }) => {
  document.getElementById('now-playing').style.display = '';
  document.getElementById('controls-bar').style.display = 'flex';
  document.getElementById('video-title-sidebar').textContent = title || '';
  document.getElementById('add-queue-btn').style.display = '';
  if (ytReady) {
    ignoreEvents = true;
    loadYTVideo(videoId, 0);
    setTimeout(() => ignoreEvents = false, 1000);
  } else {
    pendingVideoId = videoId;
  }
});

socket.on('video-play', ({ currentTime }) => {
  ignoreEvents = true;
  isPlaying = true;
  updatePlayPauseIcon(true);
  if (player) {
    player.seekTo(currentTime, true);
    player.playVideo();
  }
  setTimeout(() => ignoreEvents = false, 500);
});

socket.on('video-pause', ({ currentTime }) => {
  ignoreEvents = true;
  isPlaying = false;
  updatePlayPauseIcon(false);
  if (player) {
    player.seekTo(currentTime, true);
    player.pauseVideo();
  }
  setTimeout(() => ignoreEvents = false, 500);
});

socket.on('video-seek', ({ currentTime }) => {
  ignoreEvents = true;
  if (player) player.seekTo(currentTime, true);
  setTimeout(() => ignoreEvents = false, 300);
});

socket.on('force-sync', ({ currentTime, playing, videoId }) => {
  if (!player) return;
  ignoreEvents = true;
  if (videoId && videoId !== currentVideoId) {
    loadYTVideo(videoId, currentTime);
  } else {
    player.seekTo(currentTime, true);
    if (playing) player.playVideo();
    else player.pauseVideo();
  }
  setTimeout(() => ignoreEvents = false, 600);
  showToast('Synced with room ✓', 'success');
});

socket.on('periodic-sync', ({ currentTime, playing }) => {
  if (!player || !playing) return;
  const drift = Math.abs(player.getCurrentTime() - currentTime);
  if (drift > 5) {
    ignoreEvents = true;
    player.seekTo(currentTime, true);
    setTimeout(() => ignoreEvents = false, 500);
  }
});

socket.on('chat-message', (msg) => {
  appendMessage(msg);
});

socket.on('participant-update', (list) => {
  participants = {};
  list.forEach(p => participants[p.id] = p);
  renderParticipants();
  document.getElementById('count-num').textContent = list.length;
});

socket.on('queue-update', (q) => {
  queue = q;
  renderQueue();
  document.getElementById('q-count-tab').textContent = q.length;
});

socket.on('host-changed', ({ newHostId }) => {
  hostId = newHostId;
  isHost = myUserId === newHostId;
  Object.values(participants).forEach(p => p.isHost = p.id === newHostId);
  renderParticipants();
  updateHostUI();
  if (isHost) showToast('👑 You are now the host!', 'success');
});

socket.on('room-locked', (locked) => {
  roomLocked = locked;
  updateLockUI();
  showToast(locked ? '🔒 Room locked by host' : '🔓 Room unlocked');
});

socket.on('user-kicked', ({ targetId, name }) => {
  if (targetId === myUserId) {
    alert('You were removed from the room by the host.');
    location.href = '/';
  } else {
    showToast(`${name} was removed from the room`);
  }
});

// ── Disclaimer ────────────────────────────────────────────────────────────
function acceptDisclaimer() {
  const checkbox = document.getElementById('disclaimer-checkbox');
  if (checkbox && checkbox.checked) {
    document.getElementById('disclaimer-modal').style.display = 'none';
    const nameInput = document.getElementById('name-input');
    if (nameInput) nameInput.focus();
  }
}

// ── Join Modal ────────────────────────────────────────────────────────────
document.getElementById('name-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') joinRoom();
});

function joinRoom() {
  const input = document.getElementById('name-input').value.trim();
  myName = input || null;
  document.getElementById('name-modal').style.display = 'none';
  socket.emit('join-room', { roomId: ROOM_ID, displayName: myName });
}

// ── URL Input ─────────────────────────────────────────────────────────────
const urlInput = document.getElementById('url-input');
const urlStatus = document.getElementById('url-status');

urlInput.addEventListener('input', () => {
  const vid = extractYouTubeId(urlInput.value);
  if (vid) {
    urlStatus.textContent = '✅';
  } else if (urlInput.value.length > 5) {
    urlStatus.textContent = '❌';
  } else {
    urlStatus.textContent = '';
  }
});

urlInput.addEventListener('keydown', async e => {
  if (e.key === 'Enter') await submitVideo(false);
});

async function submitVideo(toQueue) {
  const vid = extractYouTubeId(urlInput.value);
  if (!vid) { showToast('Invalid YouTube URL', 'error'); return; }

  if (roomLocked && !isHost) {
    showToast('Room is locked — only the host can change video', 'error');
    return;
  }

  urlStatus.textContent = '⏳';
  const { title, thumb } = await fetchYTMeta(vid);

  if (toQueue) {
    socket.emit('queue-add', { roomId: ROOM_ID, videoId: vid, title, thumb });
    showToast(`Added to queue: ${title.substring(0, 40)}`);
  } else {
    socket.emit('load-video', { roomId: ROOM_ID, videoId: vid, title, thumb });
  }

  urlInput.value = '';
  urlStatus.textContent = '';
}

function addToQueue() { submitVideo(true); }

function extractYouTubeId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/,
    /^([A-Za-z0-9_-]{11})$/, // raw ID
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

async function fetchYTMeta(videoId) {
  // Use oEmbed for title (no API key needed)
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (res.ok) {
      const data = await res.json();
      return { title: data.title, thumb: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` };
    }
  } catch {}
  return { title: `Video ${videoId}`, thumb: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` };
}

// ── Controls ──────────────────────────────────────────────────────────────
function togglePlayPause() {
  if (!player) return;
  if (isPlaying) {
    player.pauseVideo();
  } else {
    player.playVideo();
  }
}

function requestSync() {
  socket.emit('request-sync', { roomId: ROOM_ID });
}

function playNext() {
  if (!isHost) return;
  socket.emit('queue-next', { roomId: ROOM_ID });
}

function toggleLock() {
  socket.emit('toggle-lock', { roomId: ROOM_ID });
}

// ── Queue ─────────────────────────────────────────────────────────────────
function renderQueue() {
  const list = document.getElementById('queue-list');
  document.getElementById('queue-count').textContent = `${queue.length} / 10`;
  document.getElementById('next-btn').style.display = (isHost && queue.length > 0) ? '' : 'none';

  if (!queue.length) {
    list.innerHTML = '<div class="queue-empty">Queue is empty — paste a URL above and hit <strong>+ Queue</strong></div>';
    return;
  }
  list.innerHTML = queue.map((item, i) => `
    <div class="queue-item" id="qi-${item.id}">
      <img class="queue-thumb" src="${item.thumb}" alt="" onerror="this.src=''" />
      <div class="queue-info">
        <div class="queue-title">${escHtml(item.title)}</div>
        <div class="queue-num">#${i + 1} in queue</div>
      </div>
      ${isHost ? `<button class="queue-remove" onclick="removeFromQueue('${item.id}')" title="Remove">✕</button>` : ''}
    </div>
  `).join('');
}

function removeFromQueue(queueId) {
  socket.emit('queue-remove', { roomId: ROOM_ID, queueId });
}

// ── Chat ──────────────────────────────────────────────────────────────────
document.getElementById('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendMessage();
});

function sendMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chat-message', { roomId: ROOM_ID, text });
  input.value = '';
}

function appendMessage(msg) {
  const box = document.getElementById('messages');
  const div = document.createElement('div');

  if (msg.system) {
    div.className = 'msg-system';
    div.textContent = msg.text;
  } else {
    div.className = 'msg';
    const isMe = msg.userId === myUserId;
    const pInfo = participants[msg.userId];
    const pIsHost = pInfo?.isHost || msg.userId === hostId;
    const nameClass = isMe ? 'is-me' : (pIsHost ? 'is-host' : '');
    const t = new Date(msg.ts);
    const timeStr = `${t.getHours().toString().padStart(2,'0')}:${t.getMinutes().toString().padStart(2,'0')}`;
    div.innerHTML = `
      <div class="msg-header">
        <span class="msg-name ${nameClass}">${escHtml(msg.name)}${pIsHost ? ' 👑' : ''}</span>
        <span class="msg-time">${timeStr}</span>
      </div>
      <div class="msg-text">${escHtml(msg.text)}</div>
    `;
  }

  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// ── Participants ──────────────────────────────────────────────────────────
function renderParticipants() {
  const list = document.getElementById('participants-list');
  const pArr = Object.values(participants);
  document.getElementById('p-count-tab').textContent = pArr.length;
  document.getElementById('count-num').textContent = pArr.length;

  list.innerHTML = pArr.map(p => {
    const isMe = p.id === myUserId;
    const pIsHost = p.id === hostId;
    const initial = (p.name || '?')[0].toUpperCase();
    const actions = (isHost && !isMe) ? `
      <div class="p-actions">
        <button class="p-action-btn crown" onclick="passCrown('${p.id}')" title="Give host">👑</button>
        <button class="p-action-btn" onclick="kickUser('${p.id}')" title="Kick">✕</button>
      </div>` : '';
    return `
      <div class="participant">
        <div class="p-avatar">${initial}</div>
        <div class="p-info">
          <div class="p-name">${escHtml(p.name)}${isMe ? ' <span style="color:var(--muted);font-size:.7rem">(you)</span>' : ''}${pIsHost ? '<span class="p-host-badge">HOST</span>' : ''}</div>
        </div>
        ${actions}
      </div>
    `;
  }).join('');

  updateHostUI();
}

function updateHostUI() {
  document.getElementById('host-controls').style.display = isHost ? '' : 'none';
}

function updateLockUI() {
  const lockBadge = document.getElementById('lock-indicator');
  const lockBtnText = document.getElementById('lock-btn-text');
  lockBadge.style.display = roomLocked ? '' : 'none';
  if (lockBtnText) lockBtnText.textContent = roomLocked ? '🔓 Unlock Room' : '🔒 Lock Room';
}

function passCrown(targetId) {
  if (!confirm('Give host status to this user?')) return;
  socket.emit('pass-crown', { roomId: ROOM_ID, targetId });
}

function kickUser(targetId) {
  if (!confirm('Remove this user from the room?')) return;
  socket.emit('kick-user', { roomId: ROOM_ID, targetId });
}

// ── Tabs ──────────────────────────────────────────────────────────────────
function switchTab(tab, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('chat-panel').style.display = tab === 'chat' ? '' : 'none';
  document.getElementById('queue-panel').style.display = tab === 'queue' ? '' : 'none';
  document.getElementById('participants-panel').style.display = tab === 'participants' ? '' : 'none';
}

// ── Copy Link ─────────────────────────────────────────────────────────────
function copyRoomLink() {
  const url = `${location.origin}/room.html?room=${ROOM_ID}`;
  navigator.clipboard.writeText(url).then(() => {
    showToast('Room link copied to clipboard! ✓', 'success');
  }).catch(() => {
    prompt('Copy this link:', url);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show' + (type ? ` ${type}` : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = '', 3000);
}

function escHtml(str = '') {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Init ──────────────────────────────────────────────────────────────────
// Focus name input
window.addEventListener('load', () => {
  // Disclaimer checkbox listener
  const disclaimerCheck = document.getElementById('disclaimer-checkbox');
  const disclaimerBtn = document.getElementById('disclaimer-btn');
  if (disclaimerCheck && disclaimerBtn) {
    disclaimerCheck.addEventListener('change', () => {
      disclaimerBtn.disabled = !disclaimerCheck.checked;
    });
  }

  const nameInput = document.getElementById('name-input');
  if (nameInput) {
    nameInput.focus();
    // Mobile focus fix
    nameInput.addEventListener('touchstart', () => nameInput.focus());
  }
  
  // Mobile keyboard focus fix for chat
  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    chatInput.addEventListener('touchstart', (e) => {
      // Don't prevent default, we want the focus
      chatInput.focus();
    });
  }
});

// Add to queue button visibility on URL input
urlInput.addEventListener('input', () => {
  const vid = extractYouTubeId(urlInput.value);
  document.getElementById('add-queue-btn').style.display = vid ? '' : 'none';
});
