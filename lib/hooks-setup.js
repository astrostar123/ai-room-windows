// Adds (or removes) AI Room's hooks in ~/.claude/settings.json.
//
// Hooks are little commands Claude Code runs at key moments ("about to use a
// tool", "finished", "needs permission"). Ours just tell the Room what's going
// on. A backup of settings.json is saved before every change.

const fs = require('fs');
const path = require('path');
const { CLAUDE_SETTINGS, ROOM_DIR, APP_DIR, readJson, writeJson } = require('./config');

const HOOK_SOURCE = path.join(APP_DIR, 'hook.js');
const HOOK_TARGET = path.join(ROOM_DIR, 'hook.js'); // a stable copy, so moving this folder can't break Claude

// Which events we listen to. "async" hooks never slow Claude down.
// PreToolUse waits briefly (that's how Stop works) and PermissionRequest waits
// for your Allow/Deny.
const EVENTS = [
  { event: 'PermissionRequest', matcher: '*', timeout: 600 },
  { event: 'PreToolUse', matcher: '*', timeout: 15 },
  { event: 'PostToolUse', matcher: '*', async: true },
  { event: 'Notification', matcher: '*', async: true },
  { event: 'UserPromptSubmit', async: true },
  { event: 'Stop', async: true },
  { event: 'StopFailure', async: true },
  { event: 'SessionStart', async: true },
  { event: 'SessionEnd', timeout: 5 },
];

function isOurs(hook) {
  return !!hook && Array.isArray(hook.args) &&
    hook.args.some((a) => String(a).replace(/\\/g, '/').toLowerCase().endsWith('/ai-room/hook.js'));
}

function readSettings() {
  if (!fs.existsSync(CLAUDE_SETTINGS)) return {};
  const text = fs.readFileSync(CLAUDE_SETTINGS, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Could not read ~/.claude/settings.json (it is not valid JSON), so nothing was changed.');
  }
}

// Removes every hook entry that belongs to AI Room. Returns how many it found.
function stripOurs(settings) {
  let found = 0;
  const hooks = settings.hooks || {};
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event]
      .map((group) => {
        if (!group || !Array.isArray(group.hooks)) return group;
        const kept = group.hooks.filter((h) => !isOurs(h));
        found += group.hooks.length - kept.length;
        return { ...group, hooks: kept };
      })
      .filter((group) => !group || !Array.isArray(group.hooks) || group.hooks.length > 0);
    if (hooks[event].length === 0) delete hooks[event];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return found;
}

function backup() {
  if (!fs.existsSync(CLAUDE_SETTINGS)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(ROOM_DIR, `settings-backup-${stamp}.json`);
  fs.copyFileSync(CLAUDE_SETTINGS, file);
  return file;
}

// Keeps ~/.claude/ai-room/hook.js up to date with the copy in this folder.
function copyHookScript() {
  fs.copyFileSync(HOOK_SOURCE, HOOK_TARGET);
}

function status() {
  let settings;
  try {
    settings = readSettings();
  } catch (err) {
    return { installed: false, partial: false, error: err.message };
  }
  const hooks = settings.hooks || {};
  let count = 0;
  for (const { event } of EVENTS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    if (groups.some((g) => g && Array.isArray(g.hooks) && g.hooks.some(isOurs))) count++;
  }
  return { installed: count === EVENTS.length, partial: count > 0 && count < EVENTS.length, error: null };
}

function install() {
  const settings = readSettings();
  copyHookScript();
  const backupFile = backup();
  stripOurs(settings);
  settings.hooks = settings.hooks || {};
  for (const e of EVENTS) {
    const hook = { type: 'command', command: process.execPath, args: [HOOK_TARGET] };
    if (e.async) hook.async = true;
    if (e.timeout) hook.timeout = e.timeout;
    const group = { hooks: [hook] };
    if (e.matcher) group.matcher = e.matcher;
    settings.hooks[e.event] = [...(settings.hooks[e.event] || []), group];
  }
  writeJson(CLAUDE_SETTINGS, settings);
  return { backupFile };
}

function uninstall() {
  const settings = readSettings();
  const backupFile = backup();
  const removed = stripOurs(settings);
  writeJson(CLAUDE_SETTINGS, settings);
  return { backupFile, removed };
}

module.exports = { status, install, uninstall, copyHookScript };
