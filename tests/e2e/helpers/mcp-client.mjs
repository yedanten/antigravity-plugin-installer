import { spawn } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT } from './sandbox.mjs';

/**
 * Spawn an MCP stdio server subprocess and speak newline-delimited JSON-RPC 2.0.
 */
export function spawnMcpClient({
  serverEntry = path.join(REPO_ROOT, 'server', 'index.mjs'),
  dataDir,
  env = process.env,
  cwd = REPO_ROOT,
  args = [],
} = {}) {
  const spawnArgs = [serverEntry];
  if (dataDir) {
    spawnArgs.push('--data-dir', dataDir);
  }
  spawnArgs.push(...args);

  const child = spawn(process.execPath, spawnArgs, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let nextId = 1;
  let stdoutBuf = '';
  let stderrBuf = '';
  const pending = new Map();
  let closed = false;

  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      closed = true;
      for (const [id, entry] of pending.entries()) {
        clearTimeout(entry.timer);
        entry.reject(
          new Error(
            `MCP server exited (code=${code}, signal=${signal}) before responding to id=${id}. Stderr: ${stderrBuf}`,
          ),
        );
      }
      pending.clear();
      resolve({ code, signal });
    });
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk;
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      } else if (msg.id === null && pending.has('__null__')) {
        const entry = pending.get('__null__');
        pending.delete('__null__');
        clearTimeout(entry.timer);
        entry.resolve(msg);
      }
    }
  });

  function sendRawLine(rawLine, { expectNullIdResponse = false, timeoutMs = 5000 } = {}) {
    if (closed) {
      return Promise.reject(new Error('MCP server is already closed.'));
    }
    if (!expectNullIdResponse) {
      child.stdin.write(`${rawLine}\n`);
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete('__null__');
        reject(new Error(`Timeout waiting for error response to raw line: ${rawLine}`));
      }, timeoutMs);
      pending.set('__null__', { resolve, reject, timer });
      child.stdin.write(`${rawLine}\n`);
    });
  }

  function notify(method, params) {
    if (closed) return;
    const payload = params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params };
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  function request(method, params, { timeoutMs = 20000 } = {}) {
    if (closed) {
      return Promise.reject(new Error(`Cannot send ${method}: MCP server is already closed.`));
    }
    const id = nextId++;
    const payload =
      params === undefined
        ? { jsonrpc: '2.0', id, method }
        : { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(`Timeout (${timeoutMs}ms) waiting for ${method} (id=${id}). Stderr: ${stderrBuf}`),
        );
      }, timeoutMs);

      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  async function initialize(
    protocolVersion = '2025-11-25',
    clientInfo = { name: 'e2e-test-client', version: '1.0.0' },
  ) {
    const res = await request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo,
    });
    if (res.error) {
      throw new Error(`initialize failed: ${JSON.stringify(res.error)}`);
    }
    notify('notifications/initialized', {});
    return res.result;
  }

  async function ping() {
    const res = await request('ping');
    if (res.error) throw new Error(`ping failed: ${JSON.stringify(res.error)}`);
    return res.result;
  }

  async function listTools() {
    const res = await request('tools/list');
    if (res.error) throw new Error(`tools/list failed: ${JSON.stringify(res.error)}`);
    return res.result.tools;
  }

  async function listResources() {
    const res = await request('resources/list');
    if (res.error) throw new Error(`resources/list failed: ${JSON.stringify(res.error)}`);
    return res.result.resources;
  }

  async function listResourceTemplates() {
    const res = await request('resources/templates/list');
    if (res.error) {
      throw new Error(`resources/templates/list failed: ${JSON.stringify(res.error)}`);
    }
    return res.result.resourceTemplates;
  }

  async function readResource(uri) {
    const res = await request('resources/read', { uri });
    if (res.error) {
      const err = new Error(`resources/read failed: ${res.error.message}`);
      err.rpcError = res.error;
      throw err;
    }
    return res.result;
  }

  async function callTool(name, argumentsObj = {}, { timeoutMs = 25000 } = {}) {
    const res = await request(
      'tools/call',
      { name, arguments: argumentsObj },
      { timeoutMs },
    );
    if (res.error) {
      const err = new Error(`tools/call(${name}) RPC error: ${res.error.message}`);
      err.rpcError = res.error;
      throw err;
    }
    return res.result;
  }

  async function close({ timeoutMs = 5000 } = {}) {
    if (closed) return exitPromise;
    try {
      child.stdin.end();
    } catch {
      // Ignore already ended stdin
    }
    const timer = setTimeout(() => {
      try {
        if (!closed) child.kill('SIGKILL');
      } catch {
        // Ignore
      }
    }, timeoutMs);
    const result = await exitPromise;
    clearTimeout(timer);
    return result;
  }

  return {
    child,
    sendRawLine,
    notify,
    request,
    initialize,
    ping,
    listTools,
    listResources,
    listResourceTemplates,
    readResource,
    callTool,
    getStderr: () => stderrBuf,
    close,
  };
}
