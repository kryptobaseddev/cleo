#!/usr/bin/env node
// CLEO Brain Observation Worker
// HTTP server that receives hook events and stores observations via cleo CLI.
// Designed as a background daemon — starts fast, handles errors silently.

const http = require('node:http');
const { execFileSync, execFile, fork } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = 37778;
const PID_FILE = path.join(os.homedir(), '.cleo', 'brain-worker.pid');
const LOG_FILE = path.join(os.homedir(), '.cleo', 'logs', 'brain-worker.log');
const CLEO_BIN = path.join(os.homedir(), '.cleo', 'bin', 'cleo');

// Tools to skip (too noisy or meta)
const SKIP_TOOLS = new Set([
  'ListMcpResourcesTool', 'SlashCommand', 'Skill', 'TodoWrite',
  'AskUserQuestion', 'TaskList', 'TaskUpdate', 'TaskCreate',
  'TeamCreate', 'SendMessage', 'ToolSearch',
]);
const SKIP_PREFIXES = ['mcp__cleo', 'mcp__claude-mem', 'mcp__plugin_claude-mem'];

// --- Logging ---

function ensureLogDir() {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function log(msg) {
  try {
    ensureLogDir();
    const ts = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
  } catch {
    // Silent — never crash
  }
}

// --- CLI helpers ---

function cleoObserve(text, title) {
  try {
    const args = ['memory', 'observe', text];
    if (title) {
      args.push('--title', title);
    }
    execFileSync(CLEO_BIN, args, {
      timeout: 10000,
      stdio: 'ignore',
      cwd: process.env.CLEO_PROJECT_DIR || process.cwd(),
    });
    return true;
  } catch (err) {
    log(`cleoObserve failed: ${err.message}`);
    return false;
  }
}

// --- Observation summarizer ---

function summarizeTool(toolName, toolInput) {
  const inp = toolInput || {};
  switch (toolName) {
    case 'Bash':
      return `Ran: ${String(inp.command || '').slice(0, 120)}`;
    case 'Write':
      return `Wrote: ${inp.file_path || inp.path || 'unknown'}`;
    case 'Edit':
      return `Edited: ${inp.file_path || inp.path || 'unknown'}`;
    case 'Read':
      return `Read: ${inp.file_path || inp.path || 'unknown'}`;
    case 'Glob':
      return `Glob: ${String(inp.pattern || '').slice(0, 80)}`;
    case 'Grep':
      return `Grep: ${String(inp.pattern || '').slice(0, 60)} in ${String(inp.path || '.').slice(0, 60)}`;
    case 'Agent':
      return `Spawned agent: ${String(inp.prompt || inp.description || '').slice(0, 80)}`;
    case 'WebFetch':
      return `Fetched: ${String(inp.url || '').slice(0, 120)}`;
    case 'WebSearch':
      return `Searched: ${String(inp.query || '').slice(0, 80)}`;
    default:
      return `${toolName} called`;
  }
}

function shouldSkip(toolName) {
  if (SKIP_TOOLS.has(toolName)) return true;
  for (const prefix of SKIP_PREFIXES) {
    if (toolName.startsWith(prefix)) return true;
  }
  return false;
}

// --- Event handlers ---

function handleObservation(data) {
  const toolName = data.tool_name || 'unknown';
  if (shouldSkip(toolName)) {
    log(`Skipped noisy tool: ${toolName}`);
    return;
  }
  const summary = summarizeTool(toolName, data.tool_input);
  const title = `[hook] ${toolName}`;
  log(`Observing: ${title} — ${summary}`);
  cleoObserve(summary, title);
}

function handleSummarize(_data) {
  log('Generating session summary...');
  // Best-effort session summary: capture what we can from cleo
  let sessionInfo = 'Claude Code session ended';
  try {
    const raw = execFileSync(CLEO_BIN, ['session', 'status', '--json'], {
      timeout: 10000,
      encoding: 'utf8',
      cwd: process.env.CLEO_PROJECT_DIR || process.cwd(),
    });
    const parsed = JSON.parse(raw);
    const s = parsed?.result?.session || parsed?.session || {};
    if (s.scope || s.currentTask) {
      sessionInfo = `Session ended: ${s.scope || 'unknown'} scope, task: ${s.currentTask || 'none'}`;
    }
  } catch {
    // Use default
  }
  cleoObserve(sessionInfo, '[hook] session-end');
}

function handleSessionInit(_data) {
  log('Session init received (no-op).');
  // No-op for now — placeholder for future context injection
}

// --- HTTP Server ---

function createServer() {
  return http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/hook') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');

        // Process async after responding
        try {
          const payload = JSON.parse(body);
          const event = payload.event;
          const data = typeof payload.data === 'string' ? JSON.parse(payload.data) : (payload.data || {});

          switch (event) {
            case 'observation':
              handleObservation(data);
              break;
            case 'summarize':
              handleSummarize(data);
              break;
            case 'session-init':
              handleSessionInit(data);
              break;
            default:
              log(`Unknown event: ${event}`);
          }
        } catch (err) {
          log(`Error processing hook: ${err.message}`);
        }
      });
    } else if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: process.pid, uptime: process.uptime() }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });
}

// --- PID management ---

function readPid() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (isNaN(pid)) return null;
    return pid;
  } catch {
    return null;
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writePid(pid) {
  const dir = path.dirname(PID_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(PID_FILE, String(pid));
}

function removePid() {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // Ignore
  }
}

// --- Commands ---

function startCommand() {
  // Check if already running
  const existingPid = readPid();
  if (existingPid && isRunning(existingPid)) {
    console.log(`Brain worker already running (PID ${existingPid})`);
    process.exit(0);
  }

  // Also check if port is already in use
  const net = require('node:net');
  const probe = net.createServer();
  probe.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${PORT} already in use — worker likely running`);
      process.exit(0);
    }
  });
  probe.once('listening', () => {
    probe.close(() => {
      // Port free — daemonize
      daemonize();
    });
  });
  probe.listen(PORT, '127.0.0.1');
}

function daemonize() {
  // Fork a detached child that runs the server
  const child = fork(__filename, ['--serve'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CLEO_PROJECT_DIR: process.cwd() },
  });
  child.unref();
  writePid(child.pid);
  console.log(`Brain worker started (PID ${child.pid}, port ${PORT})`);
  process.exit(0);
}

function serveCommand() {
  // This runs in the daemonized child
  writePid(process.pid);
  log(`Brain worker starting on port ${PORT} (PID ${process.pid})`);

  const server = createServer();
  server.listen(PORT, '127.0.0.1', () => {
    log(`Brain worker listening on 127.0.0.1:${PORT}`);
  });

  server.on('error', (err) => {
    log(`Server error: ${err.message}`);
    removePid();
    process.exit(1);
  });

  // Graceful shutdown
  const shutdown = () => {
    log('Brain worker shutting down...');
    server.close();
    removePid();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function stopCommand() {
  const pid = readPid();
  if (!pid) {
    console.log('Brain worker not running (no PID file)');
    process.exit(0);
  }
  if (!isRunning(pid)) {
    console.log(`Brain worker not running (stale PID ${pid})`);
    removePid();
    process.exit(0);
  }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Brain worker stopped (PID ${pid})`);
  } catch (err) {
    console.log(`Failed to stop brain worker: ${err.message}`);
  }
  removePid();
}

function statusCommand() {
  const pid = readPid();
  if (pid && isRunning(pid)) {
    console.log(`Brain worker running (PID ${pid}, port ${PORT})`);
  } else {
    console.log('Brain worker not running');
    if (pid) removePid();
  }
}

// --- Main ---

const command = process.argv[2];
switch (command) {
  case 'start':
    startCommand();
    break;
  case '--serve':
    serveCommand();
    break;
  case 'stop':
    stopCommand();
    break;
  case 'status':
    statusCommand();
    break;
  default:
    console.log('Usage: brain-worker.js <start|stop|status>');
    process.exit(1);
}
