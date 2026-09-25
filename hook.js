#!/usr/bin/env node
// AI Room hook.
// Claude Code runs this at key moments (see lib/hooks-setup.js). It sends the
// event to the AI Room app on this PC and, for permission questions, waits for
// your Allow/Deny.
//
// If AI Room isn't running, it does nothing and exits straight away, so Claude
// carries on exactly as normal.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const SERVER_FILE = path.join(os.homedir(), '.claude', 'ai-room', 'server.json');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', main);

function main() {
  let input;
  let server;
  try {
    input = JSON.parse(raw);
    server = JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8'));
    process.kill(server.pid, 0); // is AI Room actually running? (throws if not)
  } catch {
    return finish(null); // Room not running (or odd input): stay out of the way
  }

  const waitsForAnswer = input.hook_event_name === 'PermissionRequest';
  const body = JSON.stringify({ input, runId: process.env.AIROOM_RUN_ID || null });

  const req = http.request({
    host: '127.0.0.1',
    port: server.port,
    path: '/hook',
    method: 'POST',
    agent: false,
    timeout: waitsForAnswer ? 590000 : 4000,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-room-token': server.token,
      connection: 'close',
    },
  }, (res) => {
    let out = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { out += chunk; });
    res.on('end', () => {
      try {
        const reply = JSON.parse(out);
        finish(reply && reply.output ? reply.output : null);
      } catch {
        finish(null);
      }
    });
  });
  req.on('timeout', () => { req.destroy(); finish(null); });
  req.on('error', () => finish(null));
  req.end(body);
}

let finished = false;
function finish(output) {
  if (finished) return;
  finished = true;
  if (output) {
    // Claude reads this JSON (e.g. the Allow/Deny decision)
    process.stdout.write(JSON.stringify(output), () => process.exit(0));
  } else {
    process.exit(0);
  }
}
