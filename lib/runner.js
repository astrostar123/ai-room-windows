// Starts Claude from the Room:
//   * background runs  (claude -p ...)  for "Reply" and "New robot"
//   * a terminal window                  for "Open in Terminal"
//                                         (Windows Terminal on Windows, Terminal on a Mac)
// Also checks which Claude account the terminal version is signed in to.
// Every Claude run uses the account signed in on THIS computer; AI Room never
// stores or sends any login itself.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { ROOM_DIR, APP_DIR } = require('./config');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const RUNS_DIR = path.join(ROOM_DIR, 'runs');
fs.mkdirSync(RUNS_DIR, { recursive: true });

const MCP_SCRIPT = path.join(APP_DIR, 'mcp-approve.js');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let claudePath = 'claude';
const cli = { found: false, loggedIn: null, account: null, plan: null, checkedAt: 0, error: null };
const runs = new Map(); // runId -> run
let onChange = () => {};

// Where is the `claude` command?
function findClaude() {
  try {
    const out = IS_WIN
      ? execFileSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true })
      : execFileSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first) return first;
  } catch { /* not on PATH; try the usual install places */ }
  if (IS_WIN) return null;
  const home = os.homedir();
  const places = [
    path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude', '/usr/local/bin/claude',
  ];
  return places.find((p) => fs.existsSync(p)) || null;
}

function init(changed) {
  onChange = changed;
  const found = findClaude();
  if (found) {
    claudePath = found;
    cli.found = true;
  } else {
    cli.found = false;
    cli.error = 'The claude command was not found on this computer.';
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
      cli.account = j.loggedIn ? j.email || null : null;    // shown only in your own Room
      cli.plan = j.loggedIn ? j.subscriptionType || null : null;
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
    detached: !IS_WIN, // on Mac/Linux: its own process group, so Stop can end all of it
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
  if (IS_WIN) {
    execFile('taskkill', ['/PID', String(run.pid), '/T', '/F'], { windowsHide: true }, () => onChange());
  } else {
    try { process.kill(-run.pid, 'SIGTERM'); } catch { try { process.kill(run.pid, 'SIGTERM'); } catch { /* already gone */ } }
    onChange();
  }
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

// Puts text in single quotes for a Mac/Linux shell
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Opens a terminal in a folder running `claude` (optionally resuming a chat).
function openTerminal({ cwd, resumeId }) {
  if (!fs.existsSync(cwd)) throw new Error('That folder does not exist: ' + cwd);
  if (resumeId && !UUID.test(resumeId)) throw new Error('Bad session id');
  const claudeArgs = resumeId ? ['claude', '--resume', resumeId] : ['claude'];

  if (IS_MAC) {
    // Terminal.app runs the command; passing it as an argument avoids quoting trouble
    const command = `cd ${shellQuote(cwd)} && ${claudeArgs.join(' ')}`;
    execFile('osascript', [
      '-e', 'on run argv',
      '-e', 'tell application "Terminal" to do script (item 1 of argv)',
      '-e', 'tell application "Terminal" to activate',
      '-e', 'end run',
      command,
    ], () => {});
    return;
  }
  if (!IS_WIN) {
    const command = `cd ${shellQuote(cwd)} && ${claudeArgs.join(' ')}; exec $SHELL`;
    spawn('x-terminal-emulator', ['-e', 'sh', '-c', command], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    return;
  }

  if (/["%]/.test(cwd)) throw new Error('Folder name has characters the terminal cannot handle.');
  const wt = spawn('wt.exe', ['-d', cwd, ...claudeArgs], { detached: true, stdio: 'ignore', windowsHide: false });
  wt.on('error', () => {
    // No Windows Terminal: fall back to a classic console window
    const cmd = `start "Claude" /D "${cwd}" cmd /k ${claudeArgs.join(' ')}`;
    spawn('cmd.exe', ['/c', cmd], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
  });
  wt.unref();
}

// Opens the Room in its own "app" window (no tabs or address bar) if a
// Chromium browser is there, otherwise in the normal browser.
function openRoomWindow(url) {
  if (IS_MAC) {
    const tries = [
      ['-na', 'Google Chrome', '--args', `--app=${url}`, '--window-size=1440,920'],
      ['-na', 'Microsoft Edge', '--args', `--app=${url}`, '--window-size=1440,920'],
      ['-na', 'Brave Browser', '--args', `--app=${url}`, '--window-size=1440,920'],
      [url],
    ];
    const attempt = (k) => {
      if (k < tries.length) execFile('open', tries[k], (err) => { if (err) attempt(k + 1); });
    };
    attempt(0);
    return;
  }
  if (!IS_WIN) {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    return;
  }
  const edge = spawn('cmd.exe', ['/c', 'start', '""', 'msedge', `--app=${url}`, '--window-size=1440,920'], {
    detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true,
  });
  edge.on('exit', (code) => {
    if (code) spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
  });
  edge.unref();
}

module.exports = {
  init, checkCli, cli, runs, start, stop, activeRunFor, latestRunFor, openTerminal, openRoomWindow, UUID, IS_WIN, IS_MAC,
};
