import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { loadQuestions } from './sheets.mjs';
import { RoomStore } from './store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

// Load .env if present (zero external dependency)
function loadEnv() {
  const envPath = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadEnv();

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '2026';
const EVENT_TITLE = process.env.EVENT_TITLE || '2026 招生說明會 × 親師即時互動';
const INITIAL_SHEET_URL = process.env.GOOGLE_SHEET_CSV_URL || '';

const store = new RoomStore({ eventTitle: EVENT_TITLE });

// Cache HTML assets in memory for maximum concurrency
const htmlCache = {};
function loadHtmlAssets() {
  for (const name of ['mobile', 'stage', 'admin']) {
    const filePath = path.join(ROOT_DIR, 'public', `${name}.html`);
    const raw = fs.readFileSync(filePath);
    htmlCache[name] = {
      raw,
      gzip: zlib.gzipSync(raw),
    };
  }
}
loadHtmlAssets();

// Connected SSE clients
const mobileClients = new Set();
const stageClients = new Set();

let stageBroadcastScheduled = false;
function scheduleStageBroadcast() {
  if (stageBroadcastScheduled || stageClients.size === 0) return;
  stageBroadcastScheduled = true;
  setTimeout(() => {
    stageBroadcastScheduled = false;
    const payload = `data: ${JSON.stringify(store.getStageState())}\n\n`;
    for (const res of stageClients) {
      res.write(payload);
    }
  }, 80); // Coalesce bursts at ~12.5 Hz so 4K stage renders at smooth 60 FPS
}

function broadcastMobileState() {
  if (mobileClients.size === 0) return;
  const payload = `data: ${JSON.stringify(store.getMobileState())}\n\n`;
  for (const res of mobileClients) {
    res.write(payload);
  }
}

store.subscribe((eventType) => {
  if (eventType === 'state' || eventType === 'questions') {
    broadcastMobileState();
  }
  scheduleStageBroadcast();
});

// Keep-alive heartbeat for SSE connections (every 20s)
setInterval(() => {
  for (const res of mobileClients) res.write(': ping\n\n');
  for (const res of stageClients) res.write(': ping\n\n');
}, 20000);

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(req, res, name) {
  const asset = htmlCache[name];
  if (!asset) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  const acceptEnc = req.headers['accept-encoding'] || '';
  if (acceptEnc.includes('gzip')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Encoding': 'gzip',
      'Cache-Control': 'no-cache',
    });
    res.end(asset.gzip);
  } else {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(asset.raw);
  }
}

function readJsonBody(req, maxBytes = 32768) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function isAdminAuthorized(req, body) {
  const headerPass = req.headers['x-admin-password'];
  const pass = headerPass || body?.password || '';
  return pass === ADMIN_PASSWORD;
}

function getLanUrls() {
  const nets = os.networkInterfaces();
  const urls = [];
  for (const iface of Object.values(nets)) {
    if (!iface) continue;
    for (const info of iface) {
      if (info.family === 'IPv4' && !info.internal) {
        urls.push(`http://${info.address}:${PORT}`);
      }
    }
  }
  if (urls.length === 0) urls.push(`http://localhost:${PORT}`);
  return urls;
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;

  try {
    // Pages
    if (req.method === 'GET' && pathname === '/') return sendHtml(req, res, 'mobile');
    if (req.method === 'GET' && pathname === '/stage') return sendHtml(req, res, 'stage');
    if (req.method === 'GET' && pathname === '/admin') return sendHtml(req, res, 'admin');

    // Sample CSV download
    if (req.method === 'GET' && pathname === '/api/sample.csv') {
      const csv = fs.readFileSync(path.join(ROOT_DIR, 'sample-questions.csv'));
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="sample-questions.csv"',
      });
      res.end(csv);
      return;
    }

    // Offline-capable QR SVG endpoint
    if (req.method === 'GET' && pathname === '/api/qr.svg') {
      const target = reqUrl.searchParams.get('url') || getLanUrls()[0];
      const svg = await QRCode.toString(target, {
        type: 'svg',
        margin: 1,
        color: { dark: '#0f172a', light: '#ffffff' },
      });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      res.end(svg);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/network-info') {
      return sendJson(res, 200, { port: PORT, urls: getLanUrls() });
    }

    // Mobile short-poll state
    if (req.method === 'GET' && pathname === '/api/state') {
      return sendJson(res, 200, store.getMobileState());
    }

    // Stage initial state
    if (req.method === 'GET' && pathname === '/api/stage-state') {
      return sendJson(res, 200, store.getStageState());
    }

    // Mobile SSE stream (room state only, ultra-low bandwidth)
    if (req.method === 'GET' && pathname === '/api/stream/mobile') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`data: ${JSON.stringify(store.getMobileState())}\n\n`);
      mobileClients.add(res);
      req.on('close', () => mobileClients.delete(res));
      return;
    }

    // Stage SSE stream
    if (req.method === 'GET' && pathname === '/api/stream/stage') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`data: ${JSON.stringify(store.getStageState())}\n\n`);
      stageClients.add(res);
      req.on('close', () => stageClients.delete(res));
      return;
    }

    // High-concurrency mobile vote submission
    if (req.method === 'POST' && pathname === '/api/vote') {
      const body = await readJsonBody(req);
      const result = store.submitVote(body);
      return sendJson(res, result.ok ? 200 : 400, result);
    }

    // Stage hotkeys (1~5 manual adjust, B burst test)
    if (req.method === 'POST' && pathname === '/api/stage/hotkey') {
      const body = await readJsonBody(req);
      if (body.action === 'burst') {
        store.simulateBurst(50);
        return sendJson(res, 200, { ok: true });
      }
      if (body.action === 'adjust') {
        const ok = store.adjustVoteHotkey(Number(body.optNum), Number(body.delta) || 5);
        return sendJson(res, ok ? 200 : 400, { ok });
      }
      return sendJson(res, 400, { ok: false });
    }

    // Admin login check
    if (req.method === 'POST' && pathname === '/api/admin/login') {
      const body = await readJsonBody(req);
      if (!isAdminAuthorized(req, body)) {
        return sendJson(res, 401, { ok: false, message: '控場密碼錯誤' });
      }
      return sendJson(res, 200, { ok: true, state: store.getAdminState() });
    }

    // Admin state
    if (req.method === 'GET' && pathname === '/api/admin/state') {
      if (!isAdminAuthorized(req, null)) {
        return sendJson(res, 401, { ok: false, message: '未授權' });
      }
      return sendJson(res, 200, store.getAdminState());
    }

    // Admin control actions
    if (req.method === 'POST' && pathname === '/api/admin/control') {
      const body = await readJsonBody(req);
      if (!isAdminAuthorized(req, body)) {
        return sendJson(res, 401, { ok: false, message: '未授權' });
      }
      const { action } = body;
      if (action === 'standby') store.setStandby(body.value);
      else if (action === 'prev') store.goToQuestion(store.currentQuestionIndex - 1);
      else if (action === 'next') store.goToQuestion(store.currentQuestionIndex + 1);
      else if (action === 'goto') store.goToQuestion(Number(body.index));
      else if (action === 'status') store.setStatus(body.status);
      else if (action === 'reset') store.resetCurrentQuestion();
      else if (action === 'spotlight') store.setSpotlight(body.msgId || null);
      else if (action === 'hideMessage') store.toggleHideMessage(body.msgId, body.hidden);
      else return sendJson(res, 400, { ok: false, message: '未知指令' });

      return sendJson(res, 200, { ok: true, state: store.getAdminState() });
    }

    // Admin Google Sheets sync
    if (req.method === 'POST' && pathname === '/api/admin/sheet') {
      const body = await readJsonBody(req);
      if (!isAdminAuthorized(req, body)) {
        return sendJson(res, 401, { ok: false, message: '未授權' });
      }
      const url = String(body.sheetUrl || '').trim();
      const loaded = await loadQuestions(url);
      store.setQuestions(loaded.questions, loaded.source, url);
      return sendJson(res, 200, {
        ok: true,
        count: loaded.questions.length,
        source: loaded.source,
        state: store.getAdminState(),
      });
    }

    res.writeHead(404);
    res.end('Not Found');
  } catch (err) {
    sendJson(res, 500, { ok: false, message: err?.message || 'Internal Server Error' });
  }
});

// Optimize HTTP server for 3,000+ concurrent keep-alive connections
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.maxConnections = 10000;

async function start() {
  try {
    const loaded = await loadQuestions(INITIAL_SHEET_URL);
    store.setQuestions(loaded.questions, loaded.source, INITIAL_SHEET_URL);
    console.log(`[題庫載入成功] 共 ${loaded.questions.length} 題，來源：${loaded.source}`);
  } catch (err) {
    console.error('[題庫載入失敗，改用內建示範題庫]', err.message);
    const fallback = await loadQuestions('');
    store.setQuestions(fallback.questions, fallback.source, '');
  }

  server.listen(PORT, '0.0.0.0', () => {
    const lan = getLanUrls();
    console.log('====================================================');
    console.log(`  千人現場即時互動系統已啟動 (Port: ${PORT})`);
    console.log(`  手機端 (QR Code 目標): ${lan[0]}/`);
    console.log(`  大螢幕端 (4K/1080p)  : http://localhost:${PORT}/stage`);
    console.log(`  控場後台 (密碼 ${ADMIN_PASSWORD}) : http://localhost:${PORT}/admin`);
    console.log('====================================================');
  });
}

start();
