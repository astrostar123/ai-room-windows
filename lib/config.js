// Shared paths and settings for AI Room.
// Everything AI Room saves lives in  ~/.claude/ai-room/

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');       // transcripts: one folder per project
const REGISTRY_DIR = path.join(CLAUDE_DIR, 'sessions');       // one small JSON per running Claude process
const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json'); // where hooks get installed
const ROOM_DIR = path.join(CLAUDE_DIR, 'ai-room');            // AI Room's own files
const APP_DIR = path.join(__dirname, '..');                    // this project folder
const PORT = Number(process.env.AIROOM_PORT) || 4777;

fs.mkdirSync(ROOM_DIR, { recursive: true });

// Default settings. The user can change these from the gear menu.
const DEFAULTS = {
  showHours: 12,              // show sessions that were active in the last N hours
  amberHours: 6,              // a finished session stays amber this long unless you look at it
  catchPermissions: true,     // answer permission prompts in the Room while it's on screen
  permissionTimeoutSec: 120,  // after this, hand the question back to the app/terminal
  sound: true,                // little 8-bit bleeps when a robot needs you
  notify: false,              // Windows notifications (browser asks first)
  scale: 3,                   // pixel zoom
};

// Read a JSON file, or return a fallback if it's missing or broken.
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Write JSON safely: write a temp file, then swap it in.
// On Windows the swap fails if another program is reading the file at that
// exact moment, so try a few times before writing it directly.
function writeJson(file, data) {
  const text = JSON.stringify(data, null, 2);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40); // wait 40 ms
    }
  }
  fs.writeFileSync(file, text);
  try { fs.unlinkSync(tmp); } catch { /* fine */ }
}

const SETTINGS_FILE = path.join(ROOM_DIR, 'settings.json');
const settings = { ...DEFAULTS, ...readJson(SETTINGS_FILE, {}) };

function saveSettings(changes) {
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in changes)) continue;
    const want = typeof DEFAULTS[key];
    let value = changes[key];
    if (want === 'number') value = Number(value);
    if (want === 'boolean') value = Boolean(value);
    if (want === 'number' && !Number.isFinite(value)) continue;
    settings[key] = value;
  }
  // Keep numbers in sensible ranges
  settings.showHours = clamp(settings.showHours, 1, 24 * 14);
  settings.amberHours = clamp(settings.amberHours, 0.1, 24 * 14);
  settings.permissionTimeoutSec = clamp(settings.permissionTimeoutSec, 10, 540);
  settings.scale = clamp(Math.round(settings.scale), 1, 5);
  writeJson(SETTINGS_FILE, settings);
  return settings;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

module.exports = {
  HOME, CLAUDE_DIR, PROJECTS_DIR, REGISTRY_DIR, CLAUDE_SETTINGS, ROOM_DIR, APP_DIR, PORT,
  settings, saveSettings, readJson, writeJson,
};
