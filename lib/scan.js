// The "scan": what has a session been up to?
//   * helpers     - sub-agents it started (the Agent / Task tool)
//   * connections - MCP servers and connectors it used (tools named mcp__<server>__<tool>)
//   * skills      - skills it loaded
//   * files       - files it changed, and the last commands it ran
//
// Transcripts can be many megabytes, so each file is read once and after that
// only the new lines are read. Lines that can't matter are skipped without
// being fully decoded, which keeps it quick.

const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const cache = new Map(); // transcript file -> { offset, decoder, pending, data }

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const HELPER_TOOLS = new Set(['Agent', 'Task']);

function blank() {
  return {
    firstTime: 0, lastTime: 0, prompts: 0, toolCalls: 0,
    toolCounts: {},  // tool name -> times used
    servers: {},     // MCP server -> { calls, last }
    skills: {},      // skill -> times used
    helpers: [],     // { id, description, type, started, finished }
    helperIndex: {}, // tool_use id -> helper
    files: {},       // file path -> { times, last }
    commands: [],    // last few shell commands
  };
}

function timeOf(line) {
  const m = /"timestamp":"([^"]+)"/.exec(line);
  return m ? Date.parse(m[1]) || 0 : 0;
}

// Takes one transcript line into account
function absorb(d, line) {
  if (!line || line[0] !== '{') return;
  const t = timeOf(line);
  if (t) {
    if (!d.firstTime) d.firstTime = t;
    d.lastTime = t;
  }
  if (line.includes('"isSidechain":true')) return;

  // Who is speaking is near the start of the line ("role"); the rest can be huge
  const head = line.slice(0, 800);
  if (head.includes('"role":"user"')) {
    if (line.includes('"tool_result"')) {
      // Tool results: only needed to see when a helper has finished
      for (const raw of line.match(/"tool_use_id":"([^"]+)"/g) || []) {
        const helper = d.helperIndex[raw.slice(15, -1)];
        if (helper && !helper.finished) helper.finished = t || Date.now();
      }
    } else if (!line.includes('"isMeta":true')) {
      d.prompts++; // one of your messages
    }
    return;
  }

  // Claude's tool calls
  if (!head.includes('"role":"assistant"') || !line.includes('"tool_use"')) return;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  const content = (e.message && Array.isArray(e.message.content)) ? e.message.content : [];
  for (const b of content) {
    if (!b || b.type !== 'tool_use') continue;
    const input = b.input || {};
    d.toolCalls++;
    d.toolCounts[b.name] = (d.toolCounts[b.name] || 0) + 1;

    const mcp = /^mcp__(.+?)__(.+)$/.exec(b.name || '');
    if (mcp) {
      const s = d.servers[mcp[1]] || (d.servers[mcp[1]] = { calls: 0, last: 0 });
      s.calls++;
      s.last = t;
    }
    if (b.name === 'Skill' && input.skill) d.skills[input.skill] = (d.skills[input.skill] || 0) + 1;
    if (HELPER_TOOLS.has(b.name)) {
      const helper = {
        id: b.id, description: String(input.description || input.prompt || 'helper').slice(0, 80),
        type: input.subagent_type || 'general', started: t, finished: 0,
      };
      d.helpers.push(helper);
      d.helperIndex[b.id] = helper;
    }
    if (FILE_TOOLS.has(b.name)) {
      const p = input.file_path || input.notebook_path;
      if (p) {
        const f = d.files[p] || (d.files[p] = { times: 0, last: 0 });
        f.times++;
        f.last = t;
      }
    }
    if ((b.name === 'Bash' || b.name === 'PowerShell') && input.command) {
      d.commands.push({ command: String(input.command).slice(0, 300), time: t });
      if (d.commands.length > 10) d.commands.shift();
    }
  }
}

// Reads whatever is new in a transcript and returns the running totals.
function scanFile(f) {
  let c = cache.get(f.file);
  if (!c || f.size < c.offset) {
    c = { offset: 0, decoder: new StringDecoder('utf8'), pending: '', data: blank() };
    cache.set(f.file, c);
  }
  if (f.size <= c.offset) return c.data;

  const fd = fs.openSync(f.file, 'r');
  try {
    const chunk = Buffer.alloc(Math.min(4 * 1024 * 1024, f.size - c.offset));
    while (c.offset < f.size) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, f.size - c.offset), c.offset);
      if (n <= 0) break;
      c.offset += n;
      const lines = (c.pending + c.decoder.write(chunk.subarray(0, n))).split('\n');
      c.pending = lines.pop();
      for (const line of lines) absorb(c.data, line);
    }
  } finally {
    fs.closeSync(fd);
  }
  return c.data;
}

// Sub-agent transcripts, if Claude Code keeps them next to the main one
function helperFiles(f) {
  const out = [];
  const dir = path.join(path.dirname(f.file), f.sessionId, 'subagents');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      out.push({ name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs });
    } catch { /* gone */ }
  }
  return out;
}

// Friendly names for MCP servers and connectors
const SERVER_NAMES = {
  Claude_Browser: 'Browser', 'claude-in-chrome': 'Chrome', github: 'GitHub', visualize: 'Visualize',
  'unity-mcp': 'Unity', 'packet-tracer': 'Packet Tracer', obsidian: 'Obsidian', terminal: 'Terminal',
  'scheduled-tasks': 'Scheduled tasks', 'mcp-registry': 'Connector directory', airoom: 'AI Room',
};
function serverName(id) {
  if (/^ccd_/.test(id)) return 'Claude app';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(id)) return 'Connector';
  return SERVER_NAMES[id] || id.replace(/[_-]+/g, ' ');
}

function relative(cwd, file) {
  if (!cwd) return file;
  const rel = path.relative(cwd, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
}

const WORKING_SECS = 45; // a helper whose file changed this recently is still working

// Small summary that goes to every robot (for the room and the list)
function quick(f, busy) {
  const d = scanFile(f);
  const files = helperFiles(f);
  const now = Date.now();
  const running = d.helpers.filter((h) => !h.finished).length;
  const activeFiles = files.filter((x) => now - x.mtimeMs < WORKING_SECS * 1000).length;
  const connections = {};
  for (const [id, s] of Object.entries(d.servers)) {
    const name = serverName(id);
    connections[name] = (connections[name] || 0) + s.calls;
  }
  return {
    helpersActive: Math.max(activeFiles, busy ? running : 0),
    helpersTotal: Math.max(d.helpers.length, files.length),
    connections: Object.entries(connections).sort((a, b) => b[1] - a[1]).map(([name]) => name),
    filesChanged: Object.keys(d.files).length,
  };
}

// Everything, for the scan in the side panel
function full(f, cwd, busy) {
  const d = scanFile(f);
  const files = helperFiles(f);
  const now = Date.now();
  const q = quick(f, busy);

  const connections = {};
  for (const [id, s] of Object.entries(d.servers)) {
    const name = serverName(id);
    const c = connections[name] || (connections[name] = { name, calls: 0, last: 0 });
    c.calls += s.calls;
    c.last = Math.max(c.last, s.last);
  }

  return {
    helpers: {
      active: q.helpersActive,
      total: q.helpersTotal,
      list: d.helpers.slice(-8).reverse().map((h) => ({
        description: h.description, type: h.type, started: h.started,
        working: !h.finished && (busy || files.some((x) => now - x.mtimeMs < WORKING_SECS * 1000)),
      })),
    },
    connections: Object.values(connections).sort((a, b) => b.calls - a.calls),
    skills: Object.entries(d.skills).sort((a, b) => b[1] - a[1]).map(([name, times]) => ({ name, times })),
    files: {
      total: Object.keys(d.files).length,
      recent: Object.entries(d.files).sort((a, b) => b[1].last - a[1].last).slice(0, 8)
        .map(([p, x]) => ({ path: relative(cwd, p), times: x.times, last: x.last })),
    },
    commands: d.commands.slice(-3).reverse(),
    topTools: Object.entries(d.toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, times]) => ({ name, times })),
    toolCalls: d.toolCalls,
    prompts: d.prompts,
    started: d.firstTime,
  };
}

module.exports = { quick, full };
