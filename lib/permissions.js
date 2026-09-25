// Permission requests: "Claude wants to run X — allow?"
//
// Two kinds live here:
//   * held   — the Room is holding the question open. Clicking Allow/Deny in
//              the Room answers it (the robot is standing at the door).
//   * notice — the question is being asked in the Claude app or terminal as
//              usual. The Room just shows it so you know who's waiting.

let nextId = 1;
const pending = new Map(); // id -> request

// Tools that show their own question UI. The Room never answers these,
// because "Allow" wouldn't give them the answer they need.
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode']);

function addHeld({ sessionId, runId, toolName, toolInput, cwd, source, timeoutMs, respond }) {
  const id = String(nextId++);
  const req = {
    id, sessionId, runId: runId || null, toolName, toolInput: toolInput || {}, cwd,
    source, answerable: true, createdAt: Date.now(), expiresAt: Date.now() + timeoutMs,
    respond,
  };
  // If nobody answers in time, give the question back (or deny, for Room runs)
  req.timer = setTimeout(() => answer(id, 'timeout'), timeoutMs);
  pending.set(id, req);
  return req;
}

function addNotice({ sessionId, runId, toolName, toolInput, cwd, reason }) {
  // Only keep one notice per session
  for (const r of pending.values()) {
    if (r.sessionId === sessionId && !r.answerable) pending.delete(r.id);
  }
  const id = String(nextId++);
  const req = {
    id, sessionId, runId: runId || null, toolName, toolInput: toolInput || {}, cwd,
    source: 'notice', answerable: false, reason: reason || '', createdAt: Date.now(), expiresAt: null,
  };
  pending.set(id, req);
  return req;
}

// decision: 'allow' | 'deny' | 'pass' (ask in the app instead) | 'stop' | 'timeout'
function answer(id, decision) {
  const req = pending.get(id);
  if (!req) return false;
  pending.delete(id);
  clearTimeout(req.timer);
  if (req.respond) req.respond(decision);

  // If we handed the question back to the app, keep showing it as a notice
  if (req.source === 'hook' && (decision === 'pass' || decision === 'timeout')) {
    addNotice({
      sessionId: req.sessionId, toolName: req.toolName, toolInput: req.toolInput, cwd: req.cwd,
      reason: decision === 'timeout' ? 'No answer in the Room, so it went back to the app.' : '',
    });
  }
  return true;
}

// Forget a held request without answering (e.g. the hook was cancelled).
function drop(id) {
  const req = pending.get(id);
  if (!req) return;
  clearTimeout(req.timer);
  pending.delete(id);
}

// A session did something new, so any "waiting in the app" notice is old news.
function clearNotices(sessionId) {
  for (const r of pending.values()) {
    if (r.sessionId === sessionId && !r.answerable) pending.delete(r.id);
  }
}

function forSession(sessionId) {
  const list = [...pending.values()].filter((r) => r.sessionId === sessionId);
  // Answerable ones first, oldest first
  list.sort((a, b) => (b.answerable - a.answerable) || (a.createdAt - b.createdAt));
  return list;
}

function heldForSession(sessionId) {
  return [...pending.values()].filter((r) => r.sessionId === sessionId && r.answerable);
}

// Placeholder sessions ("run-abc") get their real id once Claude reports it.
function renameSession(oldId, newId) {
  for (const r of pending.values()) if (r.sessionId === oldId) r.sessionId = newId;
}

function all() {
  return [...pending.values()];
}

module.exports = {
  INTERACTIVE_TOOLS, addHeld, addNotice, answer, drop, clearNotices, forSession, heldForSession,
  renameSession, all,
};
