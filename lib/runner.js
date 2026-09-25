// Starts Claude from the Room:
//   * background runs  (claude -p ...)  for "Reply" and "New robot"
//   * a Windows Terminal window         for "Open in Terminal"
// Also checks whether the terminal version of Claude is signed in.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { ROOM_DIR, APP_DIR } = require('./config');

const RUNS_DIR = path.join(ROOM_DIR, 'runs');
fs.mkdirSync(RUNS_DIR, { recursive: true });

const MCP_SCRIPT = path.join(APP_DIR, 'mcp-approve.js');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let claudePath = 'claude';
const cli = { found: false, loggedIn: null, checkedAt: 0, error: null };
const runs = new Map(); // runId -> run
let onChange = () => {};

function init(changed) {
  onChange = changed;
  try {
    const out = execFileSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first) {
      claudePath = first;
      cli.found = true;
    }
  } catch {
    cli.found = false;
    cli.error = 'The claude command was not found on this PC.';
  }
  checkCli();
  // Old per-run files from earlier sessions of the Room
  for (const f of fs.readdirSync(RUNS_DIR)) {
    try { fs.unlinkSync(path.join(RUNS_DIR, f)); } catch { /* in use */ }
  }
}

// Asks "claude auth status" whether the terminal version is signed in.
function checkCli() {
  if (!cli.found) return;
  execFile(claudePath, ['auth', 'status'], { timeout: 30000, windowsHide: true }, (err, stdout) => {
    try {
      const j = JSON.parse(stdout);
      cli.loggedIn = !!j.loggedIn;
      cli.error = null;
    } catch {
      cli.loggedIn = null;
      cli.error = err ? 'Could not check sign-in: ' + err.message : null;
    }
    cli.checkedAt = Date.now();
    onChange();
  });
}

// ---------------------------------------------------------------------------
// Background runs
// ---------------------------------------------------------------------------

// Starts `claude -p` in a folder. If resumeId is given, it continues that
// conversation. Permission questions come back to the Room through the tiny
// MCP tool in mcp-approve.js.
function start({ cwd, text, resumeId, port, token }) {
  if (!cli.found) throw new Error('The claude command was not found on this PC.');
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('That folder does not exist: ' + cwd);
  if (resumeId && !UUID.test(resumeId)) throw new Error('Bad session id');

  const runId = crypto.randomBytes(4).toString('hex');
  const mcpFile = path.join(RUNS_DIR, `mcp-${runId}.json`);
  fs.writeFileSync(mcpFile, JSON.stringify({
    mcpServers: {
      airoom: {
        type: 'stdio',
        command: process.execPath,
        args: [MCP_SCRIPT],
        env: { AIROOM_RUN_ID: runId, AIROOM_PORT: String(port), AIROOM_TOKEN: token },
      },
    },
  }, null, 2));

  const args = [
    '-p',
    '--output-format', 'stream-json', '--verbose',
    '--permission-prompt-tool', 'mcp__airoom__approve',
    '--mcp-config', mcpFile,
  ];
  if (resumeId) args.push('--resume', resumeId);

  // When resuming we already know the session, so the robot stays at its desk
  const run = {
    runId, cwd, prompt: text, resumeId: resumeId || null, sessionId: resumeId || null,
    status: 'running', startedAt: Date.now(), endedAt: null, error: null, pid: null,
  };
  runs.set(runId, run);

  const child = spawn(claudePath, args, {
    cwd,
    env: { ...process.env, AIROOM_RUN_ID: runId },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  run.pid = child.pid;
  run.child = child;
  child.stdin.end(text);

  // Claude prints one JSON object per line. We only need a few of them.
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.session_id && msg.session_id !== run.sessionId) {
        const oldId = run.sessionId || `run-${runId}`;
        run.sessionId = msg.session_id;
        onChange({ type: 'run-session', runId, oldId, sessionId: run.sessionId });
      }
      if (msg.type === 'result') {
        run.result = typeof msg.result === 'string' ? msg.result : '';
        if (msg.is_error) run.error = run.result || 'Claude reported an error.';
      }
    }
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });

  child.on('error', (err) => {
    run.status = 'error';
    run.error = 'Could not start claude: ' + err.message;
    run.endedAt = Date.now();
    onChange();
  });
  child.on('close', (code) => {
    if (run.status === 'running') {
      if (!run.error && code && !run.stopped) run.error = stderr.trim().split('\n').pop() || `claude exited with code ${code}`;
      run.status = run.error ? 'error' : 'done';
      run.endedAt = Date.now();
    }
    delete run.child;
    try { fs.unlinkSync(mcpFile); } catch { /* already gone */ }
    onChange();
  });

  onChange();
  return run;
}

// Stops a background run by ending its whole process tree.
function stop(runId) {
  const run = runs.get(runId);
  if (!run || run.status !== 'running' || !run.pid) return false;
  run.stopped = true;
  run.status = 'done';
  run.endedAt = Date.now();
  execFile('taskkill', ['/PID', String(run.pid), '/T', '/F'], { windowsHide: true }, () => onChange());
  return true;
}

function activeRunFor(sessionId) {
  for (const r of runs.values()) if (r.sessionId === sessionId && r.status === 'running') return r;
  return null;
}

function latestRunFor(sessionId) {
  let best = null;
  for (const r of runs.values()) if (r.sessionId === sessionId && (!best || r.startedAt > best.startedAt)) best = r;
  return best;
}

// ---------------------------------------------------------------------------
// Terminal windows
// ---------------------------------------------------------------------------

// Opens Windows Terminal in a folder running `claude` (optionally resuming).
function openTerminal({ cwd, resumeId }) {
  if (!fs.existsSync(cwd)) throw new Error('That folder does not exist: ' + cwd);
  if (resumeId && !UUID.test(resumeId)) throw new Error('Bad session id');
  if (/["%]/.test(cwd)) throw new Error('Folder name has characters the terminal cannot handle.');

  const claudeArgs = resumeId ? ['claude', '--resume', resumeId] : ['claude'];
  const wt = spawn('wt.exe', ['-d', cwd, ...claudeArgs], { detached: true, stdio: 'ignore', windowsHide: false });
  wt.on('error', () => {
    // No Windows Terminal: fall back to a classic console window
    const cmd = `start "Claude" /D "${cwd}" cmd /k ${claudeArgs.join(' ')}`;
    spawn('cmd.exe', ['/c', cmd], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
  });
  wt.unref();
}

// Opens the Room in an Edge "app" window (no tabs or address bar).
function openRoomWindow(url) {
  const edge = spawn('cmd.exe', ['/c', 'start', '""', 'msedge', `--app=${url}`, '--window-size=1440,920'], {
    detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true,
  });
  edge.on('exit', (code) => {
    if (code) spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
  });
  edge.unref();
}

module.exports = {
  init, checkCli, cli, runs, start, stop, activeRunFor, latestRunFor, openTerminal, openRoomWindow, UUID,
};
