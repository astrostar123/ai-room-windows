// Removing robots and rooms you don't need any more.
//
//   * hide:    the robot (or the whole room) disappears from AI Room. Nothing
//              is deleted. If it does something new later, it comes back.
//   * recycle: also moves a closed chat's history (its transcript) to the
//              Recycle Bin (Windows) or the Trash (Mac), so you can still
//              restore it. Project files are never touched.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { ROOM_DIR, PROJECTS_DIR, readJson, writeJson } = require('./config');

const FILE = path.join(ROOM_DIR, 'hidden.json');
const hidden = { sessions: {}, rooms: {}, ...readJson(FILE, {}) }; // id/key -> when it was hidden

function save() {
  try { writeJson(FILE, hidden); } catch { /* try again next time */ }
}

function hideSession(id) {
  hidden.sessions[id] = Date.now();
  save();
}

function hideRoom(key) {
  hidden.rooms[key] = Date.now();
  save();
}

function unhideSession(id) {
  delete hidden.sessions[id];
  save();
}

function unhideRoom(key) {
  delete hidden.rooms[key];
  save();
}

function unhideAll() {
  hidden.sessions = {};
  hidden.rooms = {};
  save();
}

// When was this robot hidden (by itself or with its room)? 0 = never
function hiddenAt(sessionId, roomKey) {
  return Math.max(hidden.sessions[sessionId] || 0, hidden.rooms[roomKey] || 0);
}

function counts() {
  return { sessions: Object.keys(hidden.sessions).length, rooms: Object.keys(hidden.rooms).length };
}

// Windows: PowerShell can move files to the Recycle Bin (plain Node can only delete for good)
const RECYCLE_SCRIPT = `
Add-Type -AssemblyName Microsoft.VisualBasic
$paths = $env:AIROOM_PATHS | ConvertFrom-Json
foreach ($p in $paths) {
  if (Test-Path -LiteralPath $p -PathType Container) {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
  } elseif (Test-Path -LiteralPath $p) {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
  }
}`;

// Moves the transcripts of these sessions (and their side folders) to the
// Recycle Bin. files = transcript list from transcripts.listFiles().
function recycle(sessionIds, files) {
  const root = path.resolve(PROJECTS_DIR) + path.sep;
  const paths = [];
  for (const id of sessionIds) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) continue;
    const f = files.find((x) => x.sessionId === id);
    if (!f) continue;
    const extra = path.join(path.dirname(f.file), id); // custom title, sub-agents, tool results
    for (const p of [f.file, extra]) {
      if (path.resolve(p).startsWith(root) && fs.existsSync(p)) paths.push(path.resolve(p));
    }
  }
  if (!paths.length) return Promise.resolve(0);
  const done = (ok) => (ok ? sessionIds.length : -1);

  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', RECYCLE_SCRIPT], {
        env: { ...process.env, AIROOM_PATHS: JSON.stringify(paths) }, windowsHide: true, timeout: 60000,
      }, (err) => resolve(done(!err)));
    });
  }
  if (process.platform === 'darwin') return toMacTrash(paths).then(done);
  // Linux and others
  return new Promise((resolve) => execFile('gio', ['trash', ...paths], (err) => resolve(done(!err))));
}

// Mac: use the built-in `trash` command if this macOS has it, else ask Finder,
// else move the files into ~/.Trash ourselves.
function toMacTrash(paths) {
  const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 60000 }, (err) => resolve(!err)));
  const finder = [
    '-e', 'on run argv',
    '-e', 'tell application "Finder"',
    '-e', 'repeat with p in argv',
    '-e', 'delete (POSIX file (p as text) as alias)',
    '-e', 'end repeat',
    '-e', 'end tell',
    '-e', 'end run',
    ...paths,
  ];
  return (fs.existsSync('/usr/bin/trash') ? run('/usr/bin/trash', paths) : Promise.resolve(false))
    .then((ok) => ok || run('osascript', finder))
    .then((ok) => {
      if (ok) return true;
      try {
        const bin = path.join(os.homedir(), '.Trash');
        for (const p of paths) {
          if (!fs.existsSync(p)) continue;
          const name = path.basename(p);
          const target = fs.existsSync(path.join(bin, name)) ? path.join(bin, `${name} ${Date.now()}`) : path.join(bin, name);
          fs.renameSync(p, target);
        }
        return true;
      } catch {
        return false;
      }
    });
}

module.exports = { hideSession, hideRoom, unhideSession, unhideRoom, unhideAll, hiddenAt, counts, recycle };
