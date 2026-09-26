// AI Room for Windows — the local server.
//
//   node server.js                       start the Room (in this console)
//   node server.js --open                ...and open the Room window
//   node server.js --background --open  run hidden, no console (what the .bat uses)
//
// It only listens on 127.0.0.1 (this PC), and every API call needs a secret
// token that only the Room page knows. Nothing is sent anywhere else.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const config = require('./lib/config');
const transcripts = require('./lib/transcripts');
const permissions = require('./lib/permissions');
const runner = require('./lib/runner');
const hooksSetup = require('./lib/hooks-setup');
const sessions = require('./lib/sessions');

const { PORT, ROOM_DIR, APP_DIR, settings } = config;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const SERVER_FILE = path.join(ROOM_DIR, 'server.json');
const SEEN_FILE = path.join(ROOM_DIR, 'seen.json');
// The secret the Room page uses. It's kept between restarts so open Room
// windows can reconnect by themselves.
const TOKEN = (() => {
  const file = path.join(ROOM_DIR, 'token.json');
  const saved = config.readJson(file, null);
  if (saved && /^[0-9a-f]{48}$/.test(saved.token)) return saved.token;
  const token = crypto.randomBytes(24).toString('hex');
  try { config.writeJson(file, { token }); } catch { /* a new one next time, that's fine */ }
  return token;
})();
const ROOM_URL = `http://127.0.0.1:${PORT}/`;
const LOG_FILE = path.join(ROOM_DIR, 'server.log');

// Changes whenever the page's files change, so open Room windows know to reload
const BUILD_ID = (() => {
  try {
    return String(Math.max(...fs.readdirSync(path.join(APP_DIR, 'public')).map((f) => fs.statSync(path.join(APP_DIR, 'public', f)).mtimeMs)));
  } catch {
    return String(Date.now());
  }
})();

// ---------------------------------------------------------------------------
// Background mode
// "Start AI Room.bat" runs us with --background. We start a hidden copy of
// ourselves (so there's no window to close by accident), send its messages to
// ~/.claude/ai-room/server.log, and this copy exits straight away.
// ---------------------------------------------------------------------------

if (process.argv.includes('--background')) {
  const wantsWindow = process.argv.includes('--open');
  isRoomUp((up) => {
    if (!up) {
      trimLog();
      const out = fs.openSync(LOG_FILE, 'a');
      const args = process.argv.slice(1).filter((a) => a !== '--background' && a !== '--open');
      spawn(process.execPath, args, { cwd: APP_DIR, detached: true, windowsHide: true, stdio: ['ignore', out, out] }).unref();
    }
    if (!wantsWindow) return process.exit(0);
    // We open the window ourselves (not the hidden copy), because Windows only
    // lets the program you just started put a window in front of you
    waitForRoom(20, () => {
      runner.openRoomWindow(ROOM_URL);
      setTimeout(() => process.exit(0), 1000);
    });
  });
  return; // the hidden copy does the rest
}

// Is AI Room already answering on its port?
function isRoomUp(done) {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/ping', timeout: 1000, headers: { host: `127.0.0.1:${PORT}` } }, (res) => {
    let out = '';
    res.on('data', (c) => { out += c; });
    res.on('end', () => done(out.includes('ai-room')));
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => done(false));
}

function waitForRoom(triesLeft, done) {
  isRoomUp((up) => {
    if (up || triesLeft <= 0) return done();
    setTimeout(() => waitForRoom(triesLeft - 1, done), 300);
  });
}

// Keeps the log file from growing forever
function trimLog() {
  try {
    const size = fs.statSync(LOG_FILE).size;
    if (size > 1024 * 1024) fs.writeFileSync(LOG_FILE, fs.readFileSync(LOG_FILE).subarray(size - 200 * 1024));
  } catch { /* no log yet */ }
}

function log(...parts) {
  const text = parts.map((p) => (p instanceof Error ? p.stack : String(p))).join(' ');
  console.log(`[${new Date().toLocaleString()}] ${text}`);
}

// A bug in one request shouldn't take the whole Room down
process.on('uncaughtException', (err) => log('Unexpected error (AI Room keeps running):', err));
process.on('unhandledRejection', (err) => log('Unexpected error (AI Room keeps running):', err));

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

const hookState = new Map(); // sessionId -> latest hook event
const stopFlags = new Map(); // sessionId -> time Stop was pressed
const clients = new Map();   // SSE clientId -> { res, visible }
const seen = config.readJson(SEEN_FILE, {}); // sessionId -> when you last looked at it

let hooksStatus = hooksSetup.status();
let lastStateJson = '';
let lastState = null;

function saveSeen() {
  const cutoff = Date.now() - 14 * 24 * 3600e3;
  for (const id of Object.keys(seen)) if (seen[id] < cutoff) delete seen[id];
  try { config.writeJson(SEEN_FILE, seen); } catch { /* not important */ }
}

// ---------------------------------------------------------------------------
// Building and pushing state to the page
// ---------------------------------------------------------------------------

function buildState() {
  const built = sessions.build({ settings, seen, hookState, stopFlags });
  return {
    ...built,
    hooks: hooksStatus,
    cli: { found: runner.cli.found, loggedIn: runner.cli.loggedIn, error: runner.cli.error },
    presence: { windows: clients.size, onScreen: visibleClients() },
    settings,
    buildId: BUILD_ID,
  };
}

function refresh(force) {
  let state;
  try {
    state = buildState();
  } catch (err) {
    log('Could not build state:', err);
    return;
  }
  const json = JSON.stringify(state);
  if (!force && json === lastStateJson) return;
  lastStateJson = json;
  lastState = state;
  for (const c of clients.values()) c.res.write(`event: state\ndata: ${json}\n\n`);
}

let refreshTimer = null;
function refreshSoon() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh();
  }, 60);
}

runner.init((event) => {
  // A background run just learned its real session id
  if (event && event.type === 'run-session') permissions.renameSession(event.oldId, event.sessionId);
  refreshSoon();
});

function visibleClients() {
  let n = 0;
  for (const c of clients.values()) if (c.visible) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Hook events from Claude Code (sent by hook.js)
// ---------------------------------------------------------------------------

const STOP_OUTPUT = {
  continue: false,
  stopReason: 'Stopped from AI Room',
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'The user pressed Stop in AI Room. Stop working and wait for their next message.',
  },
};

function hookDecision(decision) {
  const out = (d) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } });
  if (decision === 'allow') return out({ behavior: 'allow' });
  if (decision === 'deny') return out({ behavior: 'deny', message: 'The user denied this in AI Room.' });
  if (decision === 'stop') return out({ behavior: 'deny', message: 'The user pressed Stop in AI Room.', interrupt: true });
  return null; // 'pass' or 'timeout': let the app/terminal ask as usual
}

// Error details can arrive as text or as an object
function asText(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return value.message || JSON.stringify(value);
}

function onHook(body, req, res) {
  const input = body.input || {};
  const sid = input.session_id;
  const event = input.hook_event_name;
  if (!sid || !event) return sendJson(res, {});

  if (event !== 'PermissionRequest') permissions.clearNotices(sid);
  hookState.set(sid, {
    event,
    time: Date.now(),
    toolName: input.tool_name || null,
    toolInput: input.tool_input || null,
    notificationType: input.notification_type || null,
    message: asText(input.error) || asText(input.message),
    cwd: input.cwd || null,
  });
  if (event === 'UserPromptSubmit' || event === 'Stop' || event === 'SessionEnd') stopFlags.delete(sid);

  // Stop button: refuse the next tool and end the turn
  if (event === 'PreToolUse' && stopFlags.has(sid)) {
    stopFlags.delete(sid);
    refreshSoon();
    return sendJson(res, { output: STOP_OUTPUT });
  }

  if (event === 'PermissionRequest') return onPermissionHook(input, body.runId, res);

  refreshSoon();
  return sendJson(res, {});
}

function onPermissionHook(input, runId, res) {
  const sid = input.session_id;
  const toolName = input.tool_name || 'a tool';

  // Background runs from the Room ask through mcp-approve.js instead
  if (runId) return sendJson(res, {});

  const hold = settings.catchPermissions && visibleClients() > 0 && !permissions.INTERACTIVE_TOOLS.has(toolName);
  if (!hold) {
    // The app/terminal asks as usual; the Room just shows who's waiting
    const reason = permissions.INTERACTIVE_TOOLS.has(toolName)
      ? 'Answer this one in the app.'
      : !settings.catchPermissions
        ? 'Answering in the Room is turned off in settings.'
        : 'The Room was not on screen, so the app is asking.';
    permissions.addNotice({ sessionId: sid, toolName, toolInput: input.tool_input, cwd: input.cwd, reason });
    refreshSoon();
    return sendJson(res, {});
  }

  const p = permissions.addHeld({
    sessionId: sid,
    toolName,
    toolInput: input.tool_input,
    cwd: input.cwd,
    source: 'hook',
    timeoutMs: settings.permissionTimeoutSec * 1000,
    respond: (decision) => {
      sendJson(res, { output: hookDecision(decision) });
      refreshSoon();
    },
  });
  // If Claude gives up waiting (e.g. you pressed Esc), forget the question
  res.on('close', () => {
    if (!res.writableEnded) {
      permissions.drop(p.id);
      refreshSoon();
    }
  });
  refreshSoon();
}

// Permission questions from background runs (sent by mcp-approve.js)
function onMcpPermission(body, res) {
  const run = runner.runs.get(body.runId);
  if (!run || run.status !== 'running') {
    return sendJson(res, { behavior: 'deny', message: 'This run is no longer active.' });
  }
  const input = body.input || {};
  const p = permissions.addHeld({
    sessionId: run.sessionId || `run-${run.runId}`,
    runId: run.runId,
    toolName: body.tool_name || 'a tool',
    toolInput: input,
    cwd: run.cwd,
    source: 'mcp',
    timeoutMs: 15 * 60 * 1000,
    respond: (decision) => {
      if (decision === 'allow') sendJson(res, { behavior: 'allow', updatedInput: input });
      else if (decision === 'timeout') sendJson(res, { behavior: 'deny', message: 'Nobody answered in AI Room within 15 minutes.' });
      else sendJson(res, { behavior: 'deny', message: 'The user denied this in AI Room.' });
      refreshSoon();
    },
  });
  res.on('close', () => {
    if (!res.writableEnded) {
      permissions.drop(p.id);
      refreshSoon();
    }
  });
  refreshSoon();
}

// ---------------------------------------------------------------------------
// Actions from the page
// ---------------------------------------------------------------------------

function sessionCwd(id) {
  const s = lastState && lastState.sessions[id];
  return s ? s.cwd : null;
}

function stopSession(id) {
  const did = [];
  const run = runner.activeRunFor(id) || (id.startsWith('run-') ? runner.runs.get(id.slice(4)) : null);
  for (const p of permissions.heldForSession(id)) {
    permissions.answer(p.id, 'stop');
    did.push('denied');
  }
  if (run && run.status === 'running') {
    runner.stop(run.runId);
    did.push('killed');
  }
  if (!did.length) {
    stopFlags.set(id, Date.now());
    did.push(hooksStatus.installed ? 'flagged' : 'flagged-no-hooks');
  }
  refreshSoon();
  return did;
}

function startRun({ cwd, text, resumeId }) {
  const run = runner.start({ cwd, text, resumeId, port: PORT, token: TOKEN });
  return { runId: run.runId, sessionId: run.sessionId || `run-${run.runId}` };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
};

function sendJson(res, data, status = 200) {
  if (res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('Too big'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

// Security checks: only this PC, only the Room page (which knows the token).
function hostOk(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`;
}
function originOk(req) {
  const origin = req.headers.origin;
  return !origin || origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`;
}
function tokenOk(req, url) {
  const given = String(req.headers['x-room-token'] || url.searchParams.get('token') || '');
  return given.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN));
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    return res.end('Not found');
  }
  let body = fs.readFileSync(file);
  if (rel === 'index.html') body = body.toString('utf8').replace('__ROOM_TOKEN__', TOKEN);
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
}

const SESSION_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|run-[0-9a-f]{8})$/i;

async function handle(req, res) {
  if (!hostOk(req) || !originOk(req)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  const url = new URL(req.url, ROOM_URL);
  const p = url.pathname;

  // Used by a second copy of the server to find the first one
  if (p === '/api/ping') return sendJson(res, { app: 'ai-room', ok: true });

  if (req.method === 'GET' && !p.startsWith('/api/') && p !== '/hook') return serveStatic(res, p);

  if (!tokenOk(req, url)) return sendJson(res, { error: 'Bad token — reload the Room window.' }, 401);

  // ---- Claude Code -> Room ----
  if (req.method === 'POST' && p === '/hook') return onHook(await readBody(req), req, res);
  if (req.method === 'POST' && p === '/mcp-permission') return onMcpPermission(await readBody(req), res);

  // ---- Page -> Room ----
  if (req.method === 'GET' && p === '/api/state') return sendJson(res, lastState || buildState());

  if (req.method === 'GET' && p === '/api/events') {
    const clientId = url.searchParams.get('client') || crypto.randomBytes(4).toString('hex');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    if (lastStateJson) res.write(`event: state\ndata: ${lastStateJson}\n\n`);
    clients.set(clientId, { res, visible: url.searchParams.get('visible') !== '0' });
    res.on('close', () => {
      // Only forget it if this is still the same connection (the page may have reconnected)
      if (clients.get(clientId) && clients.get(clientId).res === res) clients.delete(clientId);
      refreshSoon();
    });
    refreshSoon();
    return;
  }

  let m = /^\/api\/session\/([^/]+)\/(messages|seen|reply|stop|terminal)$/.exec(p);
  if (m) {
    const [, id, action] = m;
    if (!SESSION_ID.test(id)) return sendJson(res, { error: 'Bad session id' }, 400);

    if (req.method === 'GET' && action === 'messages') {
      if (id.startsWith('run-')) {
        const run = runner.runs.get(id.slice(4));
        return sendJson(res, { items: run ? [{ kind: 'you', text: run.prompt, time: run.startedAt }] : [], trimmed: false });
      }
      const f = transcripts.listFiles().find((x) => x.sessionId === id);
      const data = f ? transcripts.readMessages(f.file) : { items: [], trimmed: false };
      const run = runner.latestRunFor(id);
      if (run && run.status === 'error') data.items.push({ kind: 'error', text: run.error, time: run.endedAt });
      return sendJson(res, data);
    }
    if (req.method !== 'POST') return sendJson(res, { error: 'Use POST' }, 405);
    const body = await readBody(req);

    if (action === 'seen') {
      seen[id] = Date.now();
      saveSeen();
      refreshSoon();
      return sendJson(res, { ok: true });
    }
    if (action === 'stop') return sendJson(res, { ok: true, did: stopSession(id) });
    if (action === 'terminal') {
      const cwd = sessionCwd(id);
      if (!cwd) return sendJson(res, { error: 'Unknown session' }, 404);
      runner.openTerminal({ cwd, resumeId: id.startsWith('run-') ? null : id });
      return sendJson(res, { ok: true });
    }
    if (action === 'reply') {
      const s = lastState && lastState.sessions[id];
      const text = String(body.text || '').trim();
      if (!s) return sendJson(res, { error: 'Unknown session' }, 404);
      if (!text) return sendJson(res, { error: 'Type a message first.' }, 400);
      if (!s.canReply) {
        const why = s.busy ? 'It is busy right now. You can reply when it has finished.' : 'Replying needs the claude command signed in.';
        return sendJson(res, { error: why }, 409);
      }
      try {
        seen[id] = Date.now();
        return sendJson(res, { ok: true, ...startRun({ cwd: s.cwd, text, resumeId: id }) });
      } catch (err) {
        return sendJson(res, { error: err.message }, 400);
      }
    }
  }

  m = /^\/api\/permission\/(\d+)$/.exec(p);
  if (m && req.method === 'POST') {
    const body = await readBody(req);
    const decision = ['allow', 'deny', 'pass'].includes(body.decision) ? body.decision : null;
    if (!decision) return sendJson(res, { error: 'Bad decision' }, 400);
    const ok = permissions.answer(m[1], decision);
    refreshSoon();
    return sendJson(res, ok ? { ok: true } : { error: 'That question was already answered.' }, ok ? 200 : 410);
  }

  if (req.method !== 'POST') return sendJson(res, { error: 'Not found' }, 404);
  const body = await readBody(req);

  switch (p) {
    case '/api/presence': {
      const c = clients.get(String(body.clientId || ''));
      if (c) c.visible = !!body.visible;
      refreshSoon();
      return sendJson(res, { ok: true, known: !!c });
    }
    case '/api/seen-all': {
      const now = Date.now();
      for (const id of Object.keys((lastState && lastState.sessions) || {})) seen[id] = now;
      saveSeen();
      refreshSoon();
      return sendJson(res, { ok: true });
    }
    case '/api/new': {
      const cwd = String(body.cwd || '').trim();
      const text = String(body.text || '').trim();
      if (!cwd || !text) return sendJson(res, { error: 'Pick a folder and type a task.' }, 400);
      try {
        return sendJson(res, { ok: true, ...startRun({ cwd: path.resolve(cwd), text }) });
      } catch (err) {
        return sendJson(res, { error: err.message }, 400);
      }
    }
    case '/api/room/terminal': {
      try {
        runner.openTerminal({ cwd: String(body.cwd || '') });
        return sendJson(res, { ok: true });
      } catch (err) {
        return sendJson(res, { error: err.message }, 400);
      }
    }
    case '/api/hooks': {
      try {
        const result = body.action === 'uninstall' ? hooksSetup.uninstall() : hooksSetup.install();
        hooksStatus = hooksSetup.status();
        refresh(true);
        return sendJson(res, { ok: true, ...result });
      } catch (err) {
        return sendJson(res, { error: err.message }, 400);
      }
    }
    case '/api/settings':
      config.saveSettings(body || {});
      refresh(true);
      return sendJson(res, { ok: true, settings });
    case '/api/cli/recheck':
      runner.checkCli();
      return sendJson(res, { ok: true });
    case '/api/quit':
      sendJson(res, { ok: true });
      log('Stopping: Quit was pressed in the Room.');
      setTimeout(() => process.exit(0), 200);
      return;
    default:
      return sendJson(res, { error: 'Not found' }, 404);
  }
}

// ---------------------------------------------------------------------------
// Start up
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    log('Request failed:', req.method, req.url.split('?')[0], err);
    sendJson(res, { error: err.message || 'Server error' }, 500);
  });
});
server.requestTimeout = 0; // permission questions can wait a long time

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') {
    log('Could not start the server:', err);
    process.exit(1);
  }
  // Another copy is probably running already: just open its window
  http.get({ host: '127.0.0.1', port: PORT, path: '/api/ping', headers: { host: `127.0.0.1:${PORT}` } }, (res) => {
    let out = '';
    res.on('data', (c) => { out += c; });
    res.on('end', () => {
      if (out.includes('ai-room')) {
        log('AI Room is already running.');
        if (process.argv.includes('--open')) runner.openRoomWindow(ROOM_URL);
        setTimeout(() => process.exit(0), 500);
      } else {
        log(`Port ${PORT} is used by another program. Set AIROOM_PORT to pick another port.`);
        process.exit(1);
      }
    });
  }).on('error', () => {
    log(`Port ${PORT} is busy.`);
    process.exit(1);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  // hook.js and mcp-approve.js read this file to find us
  config.writeJson(SERVER_FILE, { port: PORT, token: TOKEN, pid: process.pid });
  if (hooksStatus.installed) {
    try { hooksSetup.copyHookScript(); } catch { /* keep the old copy */ }
  }
  refresh(true);
  setInterval(tick, 1000);
  log(`AI Room started at ${ROOM_URL} (process ${process.pid}).`);
  if (process.argv.includes('--open')) runner.openRoomWindow(ROOM_URL);
});

let ticks = 0;
function tick() {
  ticks++;
  // Forget Stop requests nobody acted on
  for (const [id, t] of stopFlags) if (Date.now() - t > 10 * 60e3) stopFlags.delete(id);
  // Re-check hooks now and then (someone may edit settings.json by hand)
  if (ticks % 15 === 0) hooksStatus = hooksSetup.status();
  // Re-check terminal sign-in every 5 minutes until it works
  if (ticks % 300 === 0 && runner.cli.loggedIn !== true) runner.checkCli();
  // Keep SSE connections alive
  if (ticks % 20 === 0) for (const c of clients.values()) c.res.write(': ping\n\n');
  refresh();
}

function cleanup() {
  try {
    const current = config.readJson(SERVER_FILE, {});
    if (current.pid === process.pid) fs.unlinkSync(SERVER_FILE);
  } catch { /* already gone */ }
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => {
    log(`Stopping (${sig === 'SIGHUP' ? 'its window was closed' : sig}).`);
    process.exit(0);
  });
}
