/**
 * Bulk Video Downloader Server
 * Express + WebSocket server for ClassX CDN video downloads.
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const DownloadManager = require('./downloader');

// ══════════════════════════════════════════════════════════
//  CONFIGURATION - Update the token here when it expires
// ══════════════════════════════════════════════════════════

const AUTH_TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjExMDU5NTEiLCJ0aW1lc3RhbXAiOjE3ODI4MzgyMzAsIml2X3ZlciI6NSwic2Vzc2lvbiI6ImV5SjBlWEFpT2lKS1YxUWlMQ0poYkdjaU9pSklVekkxTmlKOS5leUpwWkNJNklqRXhNRFU1TlRFaUxDSmxiV0ZwYkNJNkltOXRkMkZ0WVc0eFFHZHRZV2xzTG1OdmJTSXNJbTVoYldVaU9pSnZiU0IzWVcxaGJpSXNJblJsYm1GdWRGUjVjR1VpT2lKMWMyVnlJaXdpZEdWdVlXNTBUbUZ0WlNJNkluWnBkSFJvWVd4cllXNW5ZVzVsWDJSaUlpd2lkR1Z1WVc1MFNXUWlPaUlpTENKa2FYTndiM05oWW14bElqcG1ZV3h6WlgwLlc4dDNjcWJ6U29UMlZ0WlJHclVhQ05SZERrcENmVWExU1VtU1BRXzRGVFEifQ.IqUVDGOspIN5b8c8-plzKSxLAGgSSo8stR1HPFpzczs';
const USER_ID = '1105951';
const COURSE_ID = '110';

// ══════════════════════════════════════════════════════════

const API_BASE = 'https://vitthalkanganeapi.classx.co.in';
const API_HEADERS = {
  'user-id': USER_ID,
  'auth-key': 'appxapi',
  'client-service': 'Appx',
  'source': 'windows',
  'authorization': AUTH_TOKEN,
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 vitthal_kangane/0.0.2 Electron/22.3.27',
  'origin': 'https://vkclasswindows.akamai.net.in',
  'referer': 'https://vkclasswindows.akamai.net.in/'
};

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ──────────────── WebSocket Broadcast ────────────────

const wsClients = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  console.log(`[WS] Client connected (${wsClients.size} total)`);

  ws.send(JSON.stringify({ type: 'connected', message: 'Connected to download server' }));

  // Send current queue status on connect
  const status = downloadManager.getStatus();
  ws.send(JSON.stringify({ type: 'queue_update', ...status }));

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`[WS] Client disconnected (${wsClients.size} total)`);
  });

  ws.on('error', () => wsClients.delete(ws));
});

function wsBroadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(msg); } catch (e) {}
    }
  }
}

// ──── Helper: native HTTPS API call ────
const https = require('https');
function apiGet(apiPath) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'vitthalkanganeapi.classx.co.in',
      path: apiPath,
      headers: { ...API_HEADERS, 'accept': 'application/json', 'accept-encoding': 'identity' }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('Invalid JSON: ' + d.substring(0, 200))); }
      });
    }).on('error', reject);
  });
}

// ──────────────── Download Manager ────────────────
const downloadManager = new DownloadManager(wsBroadcast, apiGet, API_HEADERS);

app.get('/api/folders', async (req, res) => {
  try {
    const parentId = req.query.parent_id || '-1';
    console.log(`[API] Fetching folders: parent_id=${parentId}`);
    const data = await apiGet(`/get/folder_contentsv3?course_id=${COURSE_ID}&parent_id=${parentId}&windowsapp=true&start=0`);
    res.json(data);
  } catch (err) {
    console.error('[API] Folders error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/video/:id', async (req, res) => {
  try {
    const videoId = req.params.id;
    console.log(`[API] Fetching video details: video_id=${videoId}`);
    const data = await apiGet(`/get/fetchVideoDetailsById?course_id=${COURSE_ID}&video_id=${videoId}&ytflag=0&folder_wise_course=1&lc_app_api_url=`);
    res.json(data);
  } catch (err) {
    console.error('[API] Video details error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────── Download Routes ────────────────

app.post('/api/download', (req, res) => {
  try {
    const { videos, quality, downloadPath, threads } = req.body;

    if (!videos || !Array.isArray(videos) || videos.length === 0) {
      return res.status(400).json({ error: 'No videos provided' });
    }

    if (threads) {
      downloadManager.setMaxConcurrent(threads);
    }

    const basePath = downloadPath || path.join(__dirname, 'downloads');
    downloadManager.addToQueue(videos, quality || '480p', basePath);

    res.json({ success: true, queued: videos.length, totalInQueue: downloadManager.queue.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/download/status', (req, res) => {
  res.json(downloadManager.getStatus());
});

app.post('/api/download/pause', (req, res) => {
  downloadManager.pause();
  res.json({ success: true, paused: true });
});

app.post('/api/download/resume', (req, res) => {
  downloadManager.resume();
  res.json({ success: true, paused: false });
});

app.post('/api/download/cancel/:id', (req, res) => {
  downloadManager.cancelDownload(req.params.id);
  res.json({ success: true });
});

app.post('/api/download/clear', (req, res) => {
  downloadManager.clearCompleted();
  res.json({ success: true });
});

app.post('/api/download/threads', (req, res) => {
  const { threads } = req.body;
  downloadManager.setMaxConcurrent(threads);
  res.json({ success: true, threads: downloadManager.maxConcurrent });
});

// ──────────────── CDN URL Parser Endpoint ────────────────

app.post('/api/parse-cdn-url', (req, res) => {
  try {
    const { cdnUrl } = req.body;
    if (!cdnUrl) {
      return res.status(400).json({ error: 'No CDN URL provided' });
    }

    const parsed = downloadManager.parseCdnUrl(cdnUrl);
    if (!parsed) {
      return res.status(400).json({ error: 'Could not parse CDN URL' });
    }

    res.json({
      success: true,
      segBase: parsed.segBase,
      vidBase: parsed.vidBase,
      quality: parsed.quality,
      token: parsed.token,
      sampleUrl: parsed.buildUrl(0)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────── Start Server ────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║     📥 Bulk Video Downloader Server          ║');
  console.log(`  ║     🌐 http://localhost:${PORT}                 ║`);
  console.log('  ║     🔌 WebSocket: ws://localhost:' + PORT + '/ws     ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
  console.log(`  ✅ Auth: User ID ${USER_ID} (token ${AUTH_TOKEN.length} chars)`);
  console.log(`  ℹ️  Update AUTH_TOKEN at top of server.js if it expires.`);
  console.log('');
});
