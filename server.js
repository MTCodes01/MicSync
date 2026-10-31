const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { networkInterfaces } = require('os');
const { WebSocketServer } = require('ws');

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

function getLocalIp() {
  const ifaces = networkInterfaces();
  const candidates = [];

  const isVirtual = (name) => {
    const lower = name.toLowerCase();
    return lower.includes('tailscale') ||
      lower.includes('virtual') ||
      lower.includes('vmware') ||
      lower.includes('vethernet') ||
      lower.includes('wsl') ||
      lower.includes('docker') ||
      lower.includes('tap') ||
      lower.includes('tun') ||
      lower.includes('vpn') ||
      lower.includes('pseudo') ||
      lower.includes('loopback');
  };

  for (const [name, list] of Object.entries(ifaces)) {
    if (!list) continue;
    for (const net of list) {
      if (net.family !== 'IPv4' || net.internal) continue;
      const parts = net.address.split('.').map(Number);
      const isCgnat = parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;

      let score = 0;
      const lowerName = name.toLowerCase();

      if (isVirtual(name) || isCgnat) {
        score -= 50;
      }
      if (lowerName.includes('wi-fi') || lowerName.includes('wifi') || lowerName.includes('wireless') || lowerName.includes('wlan')) {
        score += 40;
      } else if (lowerName.includes('ethernet') || lowerName.includes('eth') || lowerName.includes('en')) {
        score += 30;
      }

      if (net.address.startsWith('192.168.')) {
        score += 25;
      } else if (net.address.startsWith('10.') && !isCgnat) {
        score += 15;
      } else if (net.address.startsWith('172.') && parts[1] >= 16 && parts[1] <= 31) {
        score += 10;
      }

      candidates.push({ name, address: net.address, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.length > 0 ? candidates[0].address : 'localhost';
}
const localIp = getLocalIp();

const certFile = path.join(__dirname, 'cert.pem');
const keyFile = path.join(__dirname, 'key.pem');
const hasSSL = fs.existsSync(certFile) && fs.existsSync(keyFile);

// --- HTTP / HTTPS Server (serves static files & pairing info) ---
const requestHandler = (req, res) => {
  const cleanUrl = req.url.split('?')[0];

  if (cleanUrl === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ localIp, port: PORT, protocol: hasSSL ? 'https' : 'http' }));
  }

  const filePath = path.join(PUBLIC_DIR, cleanUrl === '/' ? 'index.html' : cleanUrl);
  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
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
};

const server = hasSSL
  ? https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, requestHandler)
  : http.createServer(requestHandler);

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

const proto = hasSSL ? 'https' : 'http';
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Server running (${proto.toUpperCase()})!`);
  console.log(`   Local:   ${proto}://localhost:${PORT}`);
  console.log(`   Network: ${proto}://${localIp}:${PORT}  ← open this on your phone\n`);
});
