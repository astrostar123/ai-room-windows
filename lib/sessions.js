// Builds the picture the Room draws: which rooms exist, which robots sit in
// them, and what colour each robot is.
//
// Four sources of truth, most trusted first:
//   1. Permission questions waiting for an answer      -> red
//   2. Hook events (instant, if hooks are connected)
//   3. The live session list Claude keeps in ~/.claude/sessions/
//   4. The end of each transcript file
//
// States:  working (green) · waiting (amber, "your turn") · blocked (red) · idle (grey)

const fs = require('fs');
const path = require('path');
const { REGISTRY_DIR, HOME } = require('./config');
const transcripts = require('./transcripts');
const permissions = require('./permissions');
const runner = require('./runner');

const { oneLine, summarizeTool, prettyToolName } = transcripts;

const NAMES = [
  'BOLT', 'PIXEL', 'COG', 'ZIP', 'NOVA', 'BYTE', 'RIVET', 'GIZMO', 'TICK', 'FLUX', 'MOCHI', 'KILO',
  'ECHO', 'SPARK', 'DOT', 'WIDGET', 'TURBO', 'BEEP', 'CHIP', 'ROVER', 'SUDO', 'LINT', 'QUBIT', 'NIBBLE',
];

const assignedNames = new Map(); // session id -> robot name, kept while the Room runs

// Small, stable hash so each session always gets the same name and colour.
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Live sessions (~/.claude/sessions/<pid>.json)
// ---------------------------------------------------------------------------

function isAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = "are you there?", doesn't hurt the process
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readRegistry() {
  const map = new Map();
  let names = [];
  try {
    names = fs.readdirSync(REGISTRY_DIR);
  } catch {
    return map;
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, name), 'utf8'));
    } catch {
      continue;
    }
    if (!entry || !entry.sessionId || !entry.pid || !isAlive(entry.pid)) continue;
    map.set(entry.sessionId, entry);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Words for the UI
// ---------------------------------------------------------------------------

const DOING = {
  Bash: 'Running', PowerShell: 'Running', Edit: 'Editing', MultiEdit: 'Editing', Write: 'Writing',
  Read: 'Reading', Grep: 'Searching for', Glob: 'Looking for', WebFetch: 'Opening', WebSearch: 'Searching the web for',
  Agent: 'Delegating:', Task: 'Delegating:', TodoWrite: 'Planning', NotebookEdit: 'Editing',
};
const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'Read', 'NotebookEdit']);

function doing(toolName, toolInput) {
  if (!toolName) return 'Thinking…';
  let target = oneLine(summarizeTool(toolName, toolInput), 70);
  if (FILE_TOOLS.has(toolName) && target) target = path.basename(target);
  const verb = DOING[toolName] || `Using ${prettyToolName(toolName)}`;
  return target && DOING[toolName] ? `${verb} ${target}` : verb;
}

function askVerb(toolName) {
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      return 'run';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'edit';
    case 'Write':
      return 'write';
    case 'WebFetch':
      return 'open';
    case 'WebSearch':
      return 'search the web';
    case 'Read':
      return 'read';
    default:
      return `use ${prettyToolName(toolName)}`;
  }
}

function clip(text, max) {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max) + '\n…' : s;
}

function clipLines(text, maxLines) {
  const lines = String(text || '').split('\n');
  return lines.length > maxLines ? lines.slice(0, maxLines).join('\n') + '\n…' : lines.join('\n');
}

// What the permission card shows: the exact command, or a mini diff.
function permissionView(p, more) {
  const i = p.toolInput || {};
  const view = {
    id: p.id, toolName: p.toolName, pretty: prettyToolName(p.toolName), verb: askVerb(p.toolName),
    target: '', preview: '', kind: 'text', note: '', answerable: p.answerable, source: p.source,
    expiresAt: p.expiresAt, reason: p.reason || '', more,
  };
  if (p.toolName === 'Bash' || p.toolName === 'PowerShell') {
    view.kind = 'cmd';
    view.preview = clip(i.command, 1500);
    view.note = i.description || '';
  } else if (p.toolName === 'Edit') {
    view.kind = 'diff';
    view.target = i.file_path || '';
    view.preview = clipLines(i.old_string, 8).split('\n').map((l) => '- ' + l).join('\n') + '\n' +
      clipLines(i.new_string, 8).split('\n').map((l) => '+ ' + l).join('\n');
  } else if (p.toolName === 'MultiEdit') {
    view.kind = 'diff';
    view.target = i.file_path || '';
    view.preview = `${(i.edits || []).length} changes`;
  } else if (p.toolName === 'Write') {
    view.kind = 'file';
    view.target = i.file_path || '';
    view.preview = clipLines(i.content, 12);
  } else if (p.toolName === 'WebFetch') {
    view.preview = i.url || '';
  } else {
    view.preview = clip(JSON.stringify(i, null, 2), 1200);
  }
  view.preview = clip(view.preview, 1800);
  return view;
}

// ---------------------------------------------------------------------------
// Deciding each robot's state
// ---------------------------------------------------------------------------

function deriveState(s, info, ctx, now) {
  const { settings, seen } = ctx;
  const amberMs = settings.amberHours * 3600e3;
  const seenAt = seen[s.id] || 0;
  const mtime = s.file ? s.file.mtimeMs : 0;
  const alive = !!s.reg || !!(s.run && s.run.status === 'running');
  const last = info && info.last;

  // "Your turn" — amber until you look at it (or it's been a long time)
  const finished = (t, detail = 'Finished — your turn') =>
    seenAt >= t || now - t > amberMs
      ? { state: 'idle', detail: alive ? 'Idle — session open' : 'Done' }
      : { state: 'waiting', detail, since: t };
  const failed = (t, text) =>
    seenAt >= t || now - t > amberMs
      ? { state: 'idle', detail: alive ? 'Idle — session open' : 'Done' }
      : { state: 'blocked', reason: 'error', detail: 'Error: ' + oneLine(text || 'something went wrong', 120), since: t };
  const idle = () => ({ state: 'idle', detail: alive ? 'Idle — session open' : 'Closed' });

  // 1. A permission question is waiting
  const perms = permissions.forSession(s.id);
  if (perms.length) {
    const p = perms[0];
    const target = oneLine(summarizeTool(p.toolName, p.toolInput), 60);
    return {
      state: 'blocked', reason: 'permission', since: p.createdAt,
      detail: `Wants to ${askVerb(p.toolName)}${target ? ': ' + target : ''}`,
      permission: permissionView(p, perms.length - 1),
    };
  }

  // 2. A background run started from the Room
  if (s.run && s.run.status === 'running') {
    if (s.hook && s.hook.time > s.run.startedAt) return { state: 'working', detail: doing(s.hook.toolName, s.hook.toolInput) };
    if (last && last.kind === 'tool' && last.time > s.run.startedAt) return { state: 'working', detail: doing(last.toolName, last.toolInput) };
    return { state: 'working', detail: 'Thinking…' };
  }
  if (s.run && s.run.status === 'error' && s.run.endedAt >= mtime - 2000) return failed(s.run.endedAt, s.run.error);

  // 3. Fresh hook events
  const hook = s.hook;
  const regTime = s.reg ? s.reg.statusUpdatedAt || 0 : 0;
  if (hook && hook.time >= mtime - 3000 && hook.time >= regTime - 3000) {
    switch (hook.event) {
      case 'UserPromptSubmit':
      case 'PreToolUse':
      case 'PermissionRequest': // (already answered, or it would be in step 1) — the tool is running now
        if (alive || now - hook.time < 60e3) return { state: 'working', detail: doing(hook.toolName, hook.toolInput) };
        break;
      case 'PostToolUse':
        if (alive || now - hook.time < 60e3) return { state: 'working', detail: 'Thinking…' };
        break;
      case 'Stop':
        return finished(hook.time);
      case 'StopFailure':
        return failed(hook.time, hook.message || 'Claude stopped because of an error');
      case 'Notification':
        if (hook.notificationType === 'permission_prompt') {
          return { state: 'blocked', reason: 'permission', detail: `Waiting for permission in the ${where(s, info)}` };
        }
        if (/elicitation|needs_input/.test(hook.notificationType || '')) {
          return { state: 'blocked', reason: 'question', detail: 'Has a question for you' };
        }
        if (hook.notificationType === 'idle_prompt') return finished(last ? last.time : hook.time);
        break;
      case 'SessionEnd':
        return idle();
      default:
        break;
    }
  }

  // 4. Claude's own live session list
  if (s.reg) {
    const st = String(s.reg.status || '').toLowerCase();
    if (st === 'busy' || st === 'running' || st === 'working') {
      return { state: 'working', detail: last && last.kind === 'tool' ? doing(last.toolName, last.toolInput) : 'Thinking…' };
    }
    if (/wait|block|permission|input/.test(st)) return { state: 'blocked', reason: 'question', detail: `Waiting for you in the ${where(s, info)}` };
  }

  // 5. The transcript itself
  if (last) {
    const age = now - mtime;
    switch (last.kind) {
      case 'error':
        return failed(last.time, last.text);
      case 'end':
        return finished(last.time);
      case 'tool':
        if (age < 60e3) return { state: 'working', detail: doing(last.toolName, last.toolInput) };
        return alive ? finished(last.time, 'Paused mid-task — check on it') : idle();
      case 'prompt':
      case 'result':
      case 'thinking':
        if (age < 90e3) return { state: 'working', detail: 'Thinking…' };
        return alive ? finished(last.time, 'Paused mid-task — check on it') : idle();
      default:
        return idle();
    }
  }
  return idle();
}

// "Asking in the app" notices go stale if you answered or pressed Esc in the
// app and no hook told us. The transcript moving on is our clue.
function dropStaleNotices(s, info) {
  const last = info && info.last;
  if (!last) return;
  for (const p of permissions.forSession(s.id)) {
    const movedOn = last.time > p.createdAt + 500 && ['interrupted', 'end', 'prompt', 'error'].includes(last.kind);
    if (!p.answerable && movedOn) permissions.drop(p.id);
  }
}

function where(s, info) {
  if (s.run && s.run.status === 'running') return 'AI Room';
  const ep = (s.reg && s.reg.entrypoint) || (info && info.entrypoint) || '';
  if (ep === 'claude-desktop') return 'Claude app';
  if (ep === 'cli') return 'Terminal';
  if (ep.startsWith('sdk')) return 'Background';
  return 'app';
}

function roomKey(cwd) {
  return path.resolve(cwd).replace(/[\\/]+$/, '').toLowerCase();
}

function roomName(cwd) {
  const resolved = path.resolve(cwd);
  if (roomKey(resolved) === roomKey(HOME)) return 'Home';
  return path.basename(resolved) || resolved;
}

// Uppercase drive letter looks nicer: c:\x -> C:\x
function prettyPath(cwd) {
  return cwd.replace(/^([a-z]):/, (m, d) => d.toUpperCase() + ':');
}

// ---------------------------------------------------------------------------
// The whole picture
// ---------------------------------------------------------------------------

function build(ctx) {
  const { settings, hookState, stopFlags } = ctx;
  const now = Date.now();
  const showMs = settings.showHours * 3600e3;
  const registry = readRegistry();
  const byId = new Map();
  const get = (id) => {
    if (!byId.has(id)) byId.set(id, { id });
    return byId.get(id);
  };

  for (const f of transcripts.listFiles()) get(f.sessionId).file = f;
  for (const [id, entry] of registry) get(id).reg = entry;
  for (const [id, h] of hookState) if (now - h.time < showMs) get(id).hook = h;
  for (const run of runner.runs.values()) {
    const s = get(run.sessionId || `run-${run.runId}`);
    if (!s.run || run.startedAt > s.run.startedAt) s.run = run;
  }
  for (const p of permissions.all()) get(p.sessionId).hasPermission = true;

  const sessions = {};
  const rooms = new Map();
  const counts = { working: 0, waiting: 0, blocked: 0, idle: 0 };

  for (const s of byId.values()) {
    const f = s.file;
    const lastTouch = Math.max(
      f ? f.mtimeMs : 0,
      s.hook ? s.hook.time : 0,
      s.run ? s.run.endedAt || s.run.startedAt : 0,
      s.reg ? s.reg.statusUpdatedAt || s.reg.startedAt || 0 : 0,
    );
    const runActive = s.run && s.run.status === 'running';
    if (!s.reg && !runActive && !s.hasPermission && now - lastTouch > showMs) continue;

    const info = f ? transcripts.getInfo(f) : null;
    const cwd = (s.reg && s.reg.cwd) || (info && info.cwd) || (s.hook && s.hook.cwd) || (s.run && s.run.cwd);
    if (!cwd) continue;

    dropStaleNotices(s, info);
    const st = deriveState(s, info, ctx, now);
    const alive = !!s.reg || !!runActive;
    const key = roomKey(cwd);
    const h = hash(s.id);

    if (stopFlags.has(s.id) && st.state === 'working') st.detail = 'Stopping at the next step…';

    const session = {
      id: s.id,
      room: key,
      cwd: prettyPath(cwd),
      title: (s.reg && s.reg.name) || (info && (info.title || info.agentName || info.firstPrompt)) || (s.run && oneLine(s.run.prompt, 70)) || 'New session',
      name: NAMES[h % NAMES.length],
      hue: h % 360,
      state: st.state,
      reason: st.reason || null,
      detail: st.detail,
      since: st.since || null,
      permission: st.permission || null,
      lastActivity: lastTouch,
      createdAt: (s.reg && s.reg.startedAt) || (f && f.createdMs) || (s.run && s.run.startedAt) || lastTouch,
      alive,
      where: where(s, info),
      model: (info && info.model) || null,
      branch: (info && info.gitBranch) || null,
      lastPrompt: (info && info.lastPrompt) || null,
      managed: !!runActive,
      placeholder: s.id.startsWith('run-'),
      stopping: stopFlags.has(s.id),
      runError: s.run && s.run.status === 'error' ? s.run.error : null,
    };
    // You can reply from the Room when the session isn't open anywhere else
    session.canReply = !alive && !session.placeholder && runner.cli.found;
    session.canStop = st.state === 'working' || st.state === 'blocked';

    sessions[s.id] = session;
    counts[session.state]++;

    if (!rooms.has(key)) rooms.set(key, { key, cwd: prettyPath(cwd), name: roomName(cwd), sessions: [], lastActivity: 0, hue: hash(key) % 360 });
    const room = rooms.get(key);
    room.sessions.push(session);
    room.lastActivity = Math.max(room.lastActivity, lastTouch);
  }

  // Every robot in the office gets its own name, and keeps it
  const used = new Set();
  const everyone = Object.values(sessions).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const newcomers = [];
  for (const s of everyone) {
    const kept = assignedNames.get(s.id);
    if (kept && !used.has(kept)) {
      s.name = kept;
      used.add(kept);
    } else newcomers.push(s);
  }
  for (const s of newcomers) {
    let n = NAMES.indexOf(s.name);
    let tries = 0;
    while (used.has(NAMES[n]) && tries++ < NAMES.length) n = (n + 1) % NAMES.length;
    s.name = used.has(NAMES[n]) ? NAMES[n] + (used.size % 9 + 1) : NAMES[n];
    used.add(s.name);
    assignedNames.set(s.id, s.name);
  }
  for (const room of rooms.values()) {
    room.sessions.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    room.sessions = room.sessions.map((s) => s.id);
  }

  const roomList = [...rooms.values()].sort((a, b) => b.lastActivity - a.lastActivity);
  return { rooms: roomList, sessions, counts };
}

module.exports = { build, readRegistry, roomKey, permissionView };
