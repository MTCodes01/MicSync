const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- HTTP Server (serves static files) ---
const server = http.createServer((req, res) => {
  let filePath = path.join(PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    }
  });
});

// --- WebSocket Signaling Server ---
const wss = new WebSocketServer({ server });

// We only support one "room" with two peers
let peers = [];

function broadcast(sender, data) {
  peers.forEach((peer) => {
    if (peer !== sender && peer.readyState === 1) {
      peer.send(JSON.stringify(data));
    }
  });
}

wss.on('connection', (ws) => {
  if (peers.length >= 2) {
    ws.send(JSON.stringify({ type: 'error', message: 'Room is full (max 2 devices).' }));
    ws.close();
    return;
  }

  peers.push(ws);
  console.log(`[+] Peer connected. Total peers: ${peers.length}`);

  // Notify both peers of the current count
  peers.forEach((peer) => {
    if (peer.readyState === 1) {
      peer.send(JSON.stringify({ type: 'peer-count', count: peers.length }));
    }
  });

  ws.on('message', (rawData) => {
    try {
      const msg = JSON.parse(rawData.toString());
      // Relay signaling messages (offer, answer, ice-candidate) to the other peer
      if (['offer', 'answer', 'ice-candidate'].includes(msg.type)) {
        broadcast(ws, msg);
      }
    } catch (e) {
      console.error('Invalid message:', e.message);
    }
  });

  ws.on('close', () => {
    peers = peers.filter((p) => p !== ws);
    console.log(`[-] Peer disconnected. Total peers: ${peers.length}`);
    // Notify remaining peer
    peers.forEach((peer) => {
      if (peer.readyState === 1) {
        peer.send(JSON.stringify({ type: 'peer-count', count: peers.length }));
      }
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIp = 'localhost';
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) {
        localIp = net.address;
        break;
      }
    }
    if (localIp !== 'localhost') break;
  }
  console.log(`\n🚀 Server running!`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://${localIp}:${PORT}  ← open this on your phone\n`);
});
