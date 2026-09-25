// Reads Claude Code transcripts (~/.claude/projects/<project>/<session>.jsonl).
// Each line of a transcript is one JSON "entry": a user message, an assistant
// message, a tool result, a title change, and so on.
//
// To stay fast we only ever read the END of a file to learn a session's state,
// and we cache the answer until the file changes.

const fs = require('fs');
const path = require('path');
const { PROJECTS_DIR } = require('./config');

const cache = new Map(); // file path -> { mtimeMs, size, tail, head }

// ---------------------------------------------------------------------------
// Listing transcript files
// ---------------------------------------------------------------------------

function listFiles() {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, d.name);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      // Subagent transcripts ("agent-*.jsonl") belong to their parent session
      if (!name.endsWith('.jsonl') || name.startsWith('agent-')) continue;
      const file = path.join(dir, name);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size === 0) continue;
      out.push({
        sessionId: name.slice(0, -'.jsonl'.length),
        file,
        projectDir: d.name,
        mtimeMs: st.mtimeMs,
        createdMs: st.birthtimeMs || st.ctimeMs,
        size: st.size,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading pieces of a file
// ---------------------------------------------------------------------------

function readChunk(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

// Returns the lines at the end of a file. The first line is dropped if we
// started in the middle of it.
function tailLines(file, size, bytes) {
  const start = Math.max(0, size - bytes);
  const lines = readChunk(file, start, size - start).split('\n');
  if (start > 0) lines.shift();
  return { lines, reachedStart: start === 0 };
}

function parse(line) {
  if (!line || line[0] !== '{') return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cleaning up message text for display
// ---------------------------------------------------------------------------

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

// Removes the hidden bits Claude Code adds to prompts (reminders, tags).
function cleanText(text) {
  return String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1 ')
    .replace(/<\/?(pasted_content|command-message|command-args|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr)\b[^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function oneLine(text, max = 90) {
  const s = cleanText(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// A short human description of a tool call, e.g. "npm test" or "src/App.tsx".
function summarizeTool(name, input) {
  const i = input || {};
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return i.command || '';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'Read':
      return i.file_path || '';
    case 'NotebookEdit':
      return i.notebook_path || '';
    case 'Glob':
    case 'Grep':
      return i.pattern || '';
    case 'WebFetch':
      return i.url || '';
    case 'WebSearch':
      return i.query || '';
    case 'Agent':
    case 'Task':
      return i.description || i.prompt || '';
    default: {
      const s = JSON.stringify(i);
      return s === '{}' ? '' : s;
    }
  }
}

// Turns "mcp__github__create_issue" into "github › create_issue".
function prettyToolName(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name || '');
  if (!m) return name || 'a tool';
  const server = m[1].length > 20 ? 'MCP' : m[1];
  return `${server} › ${m[2]}`;
}

// ---------------------------------------------------------------------------
// Working out what a session is doing from its last entries
// ---------------------------------------------------------------------------

// Looks at one entry and, if it's a "real" step in the conversation, says what
// kind it is. Returns null for bookkeeping entries (titles, hooks, etc.).
function classify(e) {
  if (!e || e.isSidechain) return null;
  const time = Date.parse(e.timestamp) || 0;

  if (e.type === 'assistant' && e.message) {
    const content = Array.isArray(e.message.content) ? e.message.content : [];
    if (e.isApiErrorMessage) {
      return { kind: 'error', time, uuid: e.uuid, text: oneLine(textOf(content), 140) };
    }
    const tool = [...content].reverse().find((c) => c.type === 'tool_use');
    if (tool) return { kind: 'tool', time, uuid: e.uuid, toolName: tool.name, toolInput: tool.input };
    if (e.message.stop_reason === 'tool_use') return { kind: 'thinking', time, uuid: e.uuid };
    if (content.length && content.every((c) => c.type === 'thinking' || c.type === 'redacted_thinking')) {
      return { kind: 'thinking', time, uuid: e.uuid };
    }
    return { kind: 'end', time, uuid: e.uuid, text: oneLine(textOf(content), 140) };
  }

  if (e.type === 'user' && e.message && !e.isMeta) {
    const c = e.message.content;
    if (Array.isArray(c) && c.some((x) => x && x.type === 'tool_result')) {
      return { kind: 'result', time, uuid: e.uuid };
    }
    const text = textOf(c);
    if (/^\[Request interrupted by user/.test(text)) return { kind: 'interrupted', time, uuid: e.uuid };
    if (/<command-name>|<local-command-stdout>/.test(text)) return { kind: 'command', time, uuid: e.uuid };
    return { kind: 'prompt', time, uuid: e.uuid, text: oneLine(text) };
  }

  if (e.type === 'system' && e.subtype === 'api_error') {
    const err = e.error || {};
    return { kind: 'error', time, uuid: e.uuid, text: err.formatted || err.message || 'API error' };
  }
  return null;
}

// Scans lines from the end and collects everything we need to know.
function scanTail(lines) {
  const info = {
    title: null, agentName: null, lastPrompt: null, cwd: null,
    entrypoint: null, model: null, gitBranch: null, last: null,
  };
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = parse(lines[i]);
    if (!e) continue;
    if (!info.title && e.type === 'custom-title' && e.customTitle) info.title = e.customTitle;
    if (!info.agentName && e.type === 'agent-name' && e.agentName) info.agentName = e.agentName;
    if (!info.lastPrompt && e.type === 'last-prompt' && e.lastPrompt) info.lastPrompt = oneLine(e.lastPrompt, 140);
    if (!info.cwd && e.cwd) info.cwd = e.cwd;
    if (!info.entrypoint && e.entrypoint) info.entrypoint = e.entrypoint;
    if (!info.gitBranch && e.gitBranch && e.gitBranch !== 'HEAD') info.gitBranch = e.gitBranch;
    if (!info.model && e.type === 'assistant' && e.message && e.message.model && e.message.model !== '<synthetic>') {
      info.model = e.message.model;
    }
    if (!info.last) info.last = classify(e);
    if (info.title && info.lastPrompt && info.cwd && info.last && info.model && info.entrypoint) break;
  }
  return info;
}

// The first real prompt of a session. Used as a title when there is no other.
function readHead(file, size) {
  const text = readChunk(file, 0, Math.min(size, 256 * 1024));
  for (const line of text.split('\n')) {
    const e = parse(line);
    if (!e || e.type !== 'user' || e.isMeta || e.isSidechain || !e.message) continue;
    const t = textOf(e.message.content);
    if (!t || /<command-name>|<local-command-stdout>|^\[Request interrupted/.test(t)) continue;
    const clean = oneLine(t, 70);
    if (clean) return { firstPrompt: clean, cwd: e.cwd || null };
  }
  return { firstPrompt: null, cwd: null };
}

// Main entry: everything we know about one transcript file (cached).
function getInfo(f) {
  let c = cache.get(f.file);
  if (c && c.mtimeMs === f.mtimeMs && c.size === f.size) return c.info;

  let tail = null;
  try {
    // Start with the last 64 KB; grow if the last entries are huge.
    for (const bytes of [64 * 1024, 512 * 1024, 4 * 1024 * 1024]) {
      const { lines, reachedStart } = tailLines(f.file, f.size, bytes);
      tail = scanTail(lines);
      if (tail.last || reachedStart) break;
    }
  } catch {
    tail = tail || scanTail([]);
  }

  let head = c && c.head;
  if (!head || (!head.firstPrompt && f.size !== (c && c.size))) {
    try {
      head = readHead(f.file, f.size);
    } catch {
      head = { firstPrompt: null, cwd: null };
    }
  }

  const info = { ...tail, firstPrompt: head.firstPrompt, cwd: tail.cwd || head.cwd };
  cache.set(f.file, { mtimeMs: f.mtimeMs, size: f.size, info, head });
  return info;
}

// ---------------------------------------------------------------------------
// Full conversation (for the side panel)
// ---------------------------------------------------------------------------

function readMessages(file, limit = 160) {
  const size = fs.statSync(file).size;
  const { lines, reachedStart } = tailLines(file, size, 3 * 1024 * 1024);
  const items = [];
  const toolsById = new Map();
  let lastAssistantId = null;

  for (const line of lines) {
    const e = parse(line);
    if (!e || e.isSidechain) continue;
    const time = Date.parse(e.timestamp) || 0;

    if (e.type === 'user' && e.message && !e.isMeta) {
      const c = e.message.content;
      lastAssistantId = null;
      if (Array.isArray(c) && c.some((x) => x && x.type === 'tool_result')) {
        for (const r of c) {
          if (!r || r.type !== 'tool_result') continue;
          const tool = toolsById.get(r.tool_use_id);
          if (!tool) continue;
          const txt = typeof r.content === 'string' ? r.content : textOf(r.content);
          tool.result = cleanText(txt).slice(0, 2000);
          tool.isError = !!r.is_error;
        }
        continue;
      }
      const text = textOf(c);
      if (/^\[Request interrupted by user/.test(text)) {
        items.push({ kind: 'note', text: 'You interrupted', time });
      } else if (/<command-name>|<local-command-stdout>/.test(text)) {
        const t = oneLine(text, 200);
        if (t) items.push({ kind: 'note', text: t, time });
      } else {
        const t = cleanText(text);
        if (t) items.push({ kind: 'you', text: t.slice(0, 8000), time });
      }
      continue;
    }

    if (e.type === 'assistant' && e.message) {
      const content = Array.isArray(e.message.content) ? e.message.content : [];
      if (e.isApiErrorMessage) {
        items.push({ kind: 'error', text: oneLine(textOf(content), 400), time });
        continue;
      }
      for (const block of content) {
        if (block.type === 'text' && block.text && block.text.trim()) {
          // Join text blocks of the same reply into one bubble
          const prev = items[items.length - 1];
          if (prev && prev.kind === 'claude' && lastAssistantId === e.message.id) {
            prev.text += '\n\n' + block.text.trim();
          } else {
            items.push({ kind: 'claude', text: block.text.trim(), time });
          }
          lastAssistantId = e.message.id;
        } else if (block.type === 'tool_use') {
          const tool = {
            kind: 'tool',
            name: block.name,
            pretty: prettyToolName(block.name),
            summary: oneLine(summarizeTool(block.name, block.input), 160),
            time,
          };
          toolsById.set(block.id, tool);
          items.push(tool);
          lastAssistantId = null;
        }
      }
      continue;
    }

    if (e.type === 'system' && e.subtype === 'api_error') {
      const prev = items[items.length - 1];
      const text = (e.error && (e.error.formatted || e.error.message)) || 'API error';
      if (!(prev && prev.kind === 'error' && prev.text === text)) items.push({ kind: 'error', text, time });
    }
  }

  const trimmed = items.length > limit || !reachedStart;
  return { items: items.slice(-limit), trimmed };
}

module.exports = {
  listFiles, getInfo, readMessages, summarizeTool, prettyToolName, oneLine, cleanText,
};
