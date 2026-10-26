const http = require('http');
const fs = require('fs');
const path = require('path');
const { networkInterfaces } = require('os');
const { WebSocketServer } = require('ws');

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

function getLocalIp() {
  for (const iface of Object.values(networkInterfaces())) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}
const localIp = getLocalIp();

// --- HTTP Server (serves static files & pairing info) ---
const server = http.createServer((req, res) => {
  const cleanUrl = req.url.split('?')[0];

  if (cleanUrl === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ localIp, port: PORT }));
  }

  const filePath = path.join(PUBLIC_DIR, cleanUrl === '/' ? 'index.html' : cleanUrl);
  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } else {
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      res.end(data);
    }
  });
});

// --- WebSocket Signaling Server with Multi-Room Support ---
const wss = new WebSocketServer({ server });
const rooms = new Map(); // roomId -> Set<ws>

function broadcast(roomId, sender, data) {
  const peers = rooms.get(roomId);
  if (!peers) return;
  peers.forEach((peer) => {
    if (peer !== sender && peer.readyState === 1) peer.send(JSON.stringify(data));
  });
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = (url.searchParams.get('room') || 'default').toUpperCase();

  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  const peers = rooms.get(roomId);

  if (peers.size >= 2) {
    ws.send(JSON.stringify({ type: 'error', message: `Room "${roomId}" is full (max 2 devices).` }));
    ws.close();
    return;
  }

  peers.add(ws);
  console.log(`[+] Peer connected to [${roomId}]. Total in room: ${peers.size}`);

  peers.forEach((p) => {
    if (p.readyState === 1) p.send(JSON.stringify({ type: 'peer-count', count: peers.size, roomId }));
  });

  ws.on('message', (rawData) => {
    try {
      const msg = JSON.parse(rawData.toString());
      if (['offer', 'answer', 'ice-candidate'].includes(msg.type)) {
        broadcast(roomId, ws, msg);
      }
    } catch (e) {
      console.error('Invalid message:', e.message);
    }
  });

  ws.on('close', () => {
    peers.delete(ws);
    console.log(`[-] Peer disconnected from [${roomId}]. Total in room: ${peers.size}`);
    peers.forEach((p) => {
      if (p.readyState === 1) p.send(JSON.stringify({ type: 'peer-count', count: peers.size, roomId }));
    });
    if (peers.size === 0) rooms.delete(roomId);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Server running!`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://${localIp}:${PORT}  ← open this on your phone\n`);
});
