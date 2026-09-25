#!/usr/bin/env node
// A tiny MCP server with one tool: "approve".
//
// When AI Room starts Claude in the background (Reply / New robot), there's no
// window to show permission questions in. So we start Claude with
//   --permission-prompt-tool mcp__airoom__approve
// and Claude calls this tool instead. We forward the question to the Room and
// return your Allow/Deny.
//
// MCP messages are JSON, one per line, over stdin/stdout.

const http = require('http');
const readline = require('readline');

const PORT = Number(process.env.AIROOM_PORT) || 4777;
const TOKEN = process.env.AIROOM_TOKEN || '';
const RUN_ID = process.env.AIROOM_RUN_ID || '';

const TOOL = {
  name: 'approve',
  description: 'Asks the user in AI Room whether Claude may use a tool.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name', 'input'],
  },
};

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handle(msg);
});

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'airoom', version: '1.0.0' },
      },
    });
  }
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } });
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });

  if (method === 'tools/call') {
    const args = (params && params.arguments) || {};
    let decision;
    try {
      decision = await askRoom(args);
    } catch {
      decision = { behavior: 'deny', message: 'AI Room is not running, so nobody could approve this.' };
    }
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } });
  }

  // Notifications (no id) need no reply; unknown requests get an error
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
}

// Sends the question to the Room and waits for the answer.
function askRoom(args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ runId: RUN_ID, tool_name: args.tool_name, input: args.input || {} });
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/mcp-permission', method: 'POST', agent: false,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-room-token': TOKEN,
      },
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(out)); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
