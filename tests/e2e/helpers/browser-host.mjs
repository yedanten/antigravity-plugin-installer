import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const BROWSER_CANDIDATES = [
  process.env.EDGE_BIN,
  process.env.CHROME_BIN,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

export async function findBrowserBin() {
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      const st = await fs.stat(candidate);
      if (st.isFile()) return candidate;
    } catch {
      // Try next
    }
  }
  return null;
}

async function connectCdpWebSocket(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP WebSocket connect timeout: ${wsUrl}`)), 10000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', (ev) => {
      clearTimeout(timer);
      reject(new Error(`CDP WebSocket error: ${ev?.message || 'unknown'}`));
    });
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new Error(`CDP ${entry.method} error: ${msg.error.message}`));
      } else {
        entry.resolve(msg.result);
      }
    }
  });

  ws.addEventListener('close', () => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('CDP WebSocket closed'));
    }
    pending.clear();
  });

  function send(method, params = {}, timeoutMs = 15000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout (${timeoutMs}ms) on ${method}`));
      }, timeoutMs);
      pending.set(id, { method, resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  function close() {
    try {
      ws.close();
    } catch {
      // Ignore
    }
  }

  return { ws, send, close };
}

function buildHostPageHtml(initialHostContext, initialHostCapabilities) {
  const ctxJson = JSON.stringify(initialHostContext || { theme: 'light', locale: 'en-US' });
  const capsJson = JSON.stringify(
    initialHostCapabilities || { serverTools: {}, openLinks: {} },
  );
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Antigravity MCP App E2E Host</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
    #app-frame { width: 100%; height: 100%; border: 0; display: block; }
  </style>
</head>
<body>
  <iframe id="app-frame" src="/app.html"></iframe>
  <script>
    window.__mcpHostReady = false;
    window.__hostContext = ${ctxJson};
    window.__hostCapabilities = ${capsJson};
    window.__pendingToolResult = null;
    window.__toolCalls = [];
    window.__sentMessages = [];

    const frame = document.getElementById('app-frame');

    window.__sendHostContext = function(patch) {
      window.__hostContext = Object.assign({}, window.__hostContext, patch || {});
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage({
          jsonrpc: '2.0',
          method: 'ui/notifications/host-context-changed',
          params: window.__hostContext
        }, '*');
      }
    };

    window.__sendToolResult = function(result) {
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage({
          jsonrpc: '2.0',
          method: 'ui/notifications/tool-result',
          params: result
        }, '*');
      }
    };

    window.addEventListener('message', async (ev) => {
      if (!frame || ev.source !== frame.contentWindow) return;
      const msg = ev.data;
      if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;

      if (msg.method === 'ui/initialize') {
        frame.contentWindow.postMessage({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: (msg.params && msg.params.protocolVersion) || '2026-01-26',
            hostInfo: { name: 'antigravity-e2e-host', version: '2.35.2' },
            hostCapabilities: window.__hostCapabilities,
            hostContext: window.__hostContext
          }
        }, '*');
        return;
      }

      if (msg.method === 'ui/notifications/initialized') {
        window.__mcpHostReady = true;
        if (window.__pendingToolResult) {
          const pending = window.__pendingToolResult;
          window.__pendingToolResult = null;
          window.__sendToolResult(pending);
        }
        return;
      }

      if (msg.method === 'ui/message') {
        window.__sentMessages.push(msg.params || {});
        frame.contentWindow.postMessage({
          jsonrpc: '2.0',
          id: msg.id,
          result: {}
        }, '*');
        return;
      }

      if (msg.method === 'tools/call') {
        const params = msg.params || {};
        window.__toolCalls.push({ name: params.name, arguments: params.arguments || {} });
        try {
          const resp = await fetch('/mcp/tools/call', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: params.name, arguments: params.arguments || {} })
          });
          const data = await resp.json();
          if (data && data.rpcError) {
            frame.contentWindow.postMessage({
              jsonrpc: '2.0',
              id: msg.id,
              error: data.rpcError
            }, '*');
          } else {
            frame.contentWindow.postMessage({
              jsonrpc: '2.0',
              id: msg.id,
              result: data.result
            }, '*');
          }
        } catch (err) {
          frame.contentWindow.postMessage({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32603, message: String(err && err.message ? err.message : err) }
          }, '*');
        }
        return;
      }

      if (msg.id !== undefined) {
        frame.contentWindow.postMessage({
          jsonrpc: '2.0',
          id: msg.id,
          result: {}
        }, '*');
      }
    });
  </script>
</body>
</html>`;
}

async function createMcpAppHostServer(
  mcpClient,
  {
    hostContext = { theme: 'light', locale: 'en-US' },
    hostCapabilities = { serverTools: {}, openLinks: {} },
    toolDelayMs = 0,
    toolDelayFor = null,
  } = {},
) {
  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && reqUrl.pathname === '/') {
        const html = buildHostPageHtml(hostContext, hostCapabilities);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/app.html') {
        const resource = await mcpClient.readResource('ui://plugin-installer/app.html');
        const html = resource.contents?.[0]?.text || '';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/mcp/tools/call') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');

        if (toolDelayMs > 0 && (!toolDelayFor || toolDelayFor === body.name)) {
          await new Promise((r) => setTimeout(r, toolDelayMs));
        }

        try {
          const result = await mcpClient.callTool(body.name, body.arguments || {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result }));
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              rpcError: err?.rpcError || { code: -32603, message: err?.message || String(err) },
            }),
          );
        }
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(err?.message || String(err));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Launch a reusable headless Edge/Chrome instance via CDP over Node native WebSocket.
 */
export async function launchHeadlessBrowser() {
  const browserBin = await findBrowserBin();
  if (!browserBin) {
    throw new Error('Headless Edge/Chrome executable not found.');
  }

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-e2e-browser-'));
  const proc = spawn(
    browserBin,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-extensions',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  let stderrBuf = '';
  let exited = false;
  const exitPromise = new Promise((resolve) => {
    proc.on('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });

  const browserWsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for browser DevTools URL. Stderr: ${stderrBuf}`));
    }, 15000);

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk;
      const m = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Browser exited early (${code}). Stderr: ${stderrBuf}`));
    });
  });

  const parsedBrowserWs = new URL(browserWsUrl);
  const httpDebugBase = `http://${parsedBrowserWs.host}`;
  const browserCdp = await connectCdpWebSocket(browserWsUrl);

  async function openAppSession({
    mcpClient,
    hostContext = { theme: 'light', locale: 'en-US' },
    hostCapabilities = { serverTools: {}, openLinks: {} },
    viewport = { width: 1200, height: 800 },
    toolDelayMs = 0,
    toolDelayFor = null,
    waitForReady = true,
  }) {
    const hostServer = await createMcpAppHostServer(mcpClient, {
      hostContext,
      hostCapabilities,
      toolDelayMs,
      toolDelayFor,
    });

    const { targetId } = await browserCdp.send('Target.createTarget', {
      url: 'about:blank',
    });

    let pageWsUrl = '';
    for (let i = 0; i < 20; i += 1) {
      const resp = await fetch(`${httpDebugBase}/json/list`);
      const targets = await resp.json();
      const match = targets.find((t) => t.id === targetId);
      if (match?.webSocketDebuggerUrl) {
        pageWsUrl = match.webSocketDebuggerUrl;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    if (!pageWsUrl) {
      await browserCdp.send('Target.closeTarget', { targetId }).catch(() => {});
      await hostServer.close();
      throw new Error(`Could not resolve webSocketDebuggerUrl for target ${targetId}`);
    }

    const pageCdp = await connectCdpWebSocket(pageWsUrl);
    await pageCdp.send('Page.enable');
    await pageCdp.send('Runtime.enable');
    await pageCdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await pageCdp.send('Page.navigate', { url: `${hostServer.baseUrl}/` });

    async function evalTop(fnOrCode, ...args) {
      const expr =
        typeof fnOrCode === 'function'
          ? `(${fnOrCode.toString()})(...${JSON.stringify(args)})`
          : fnOrCode;
      const res = await pageCdp.send('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      });
      if (res.exceptionDetails) {
        const desc =
          res.exceptionDetails.exception?.description ||
          res.exceptionDetails.text ||
          'Evaluation exception';
        throw new Error(`Browser evalTop failed: ${desc}`);
      }
      return res.result?.value;
    }

    async function evalInApp(fn, ...args) {
      const fnStr = fn.toString();
      const argsJson = JSON.stringify(args);
      const expr = `(() => {
        const frame = document.getElementById('app-frame');
        if (!frame || !frame.contentDocument) return { __notReady: true };
        const doc = frame.contentDocument;
        const win = frame.contentWindow;
        const fn = (${fnStr});
        return { __ok: true, value: fn(doc, win, ...${argsJson}) };
      })()`;
      const res = await pageCdp.send('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      });
      if (res.exceptionDetails) {
        const desc =
          res.exceptionDetails.exception?.description ||
          res.exceptionDetails.text ||
          'Evaluation exception';
        throw new Error(`Browser evalInApp failed: ${desc}`);
      }
      const payload = res.result?.value;
      if (payload && payload.__notReady) return undefined;
      return payload?.value;
    }

    async function waitFor(predicateFn, args = [], { timeoutMs = 10000, intervalMs = 50, label = 'condition' } = {}) {
      const deadline = Date.now() + timeoutMs;
      let lastVal;
      while (Date.now() < deadline) {
        lastVal = await evalInApp(predicateFn, ...args);
        if (lastVal) return lastVal;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      const bodyText = await getAppText().catch(() => '');
      throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms. App text:\n${bodyText}`);
    }

    async function waitForTop(predicateFn, { timeoutMs = 10000, intervalMs = 50, label = 'top condition' } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const val = await evalTop(predicateFn);
        if (val) return val;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
    }

    if (waitForReady) {
      await waitForTop(() => Boolean(window.__mcpHostReady), {
        timeoutMs: 12000,
        label: 'MCP host ready',
      });
      await waitFor(
        (doc) => {
          const app = doc.getElementById('app');
          if (!app) return false;
          const hasShell = Boolean(doc.querySelector('.shell'));
          const stillLoading = Boolean(doc.querySelector('.empty-state .spinner'));
          return hasShell && !stillLoading;
        },
        [],
        { timeoutMs: 12000, label: 'initial inventory render' },
      );
    }

    async function getAppText() {
      return evalInApp((doc) => doc.body?.innerText || '');
    }

    async function waitForText(text, opts = {}) {
      return waitFor(
        (doc, _win, expected) => (doc.body?.innerText || '').includes(expected),
        [text],
        { ...opts, label: `text "${text}"` },
      );
    }

    async function waitForSelector(selector, opts = {}) {
      return waitFor(
        (doc, _win, sel) => Boolean(doc.querySelector(sel)),
        [selector],
        { ...opts, label: `selector "${selector}"` },
      );
    }

    async function click(selector) {
      await waitForSelector(selector);
      const clicked = await evalInApp((doc, _win, sel) => {
        const el = doc.querySelector(sel);
        if (!el) return false;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.click();
        return true;
      }, selector);
      if (!clicked) throw new Error(`Could not click "${selector}"`);
    }

    async function setInputValue(selector, value) {
      await waitForSelector(selector);
      await evalInApp((doc, _win, sel, val) => {
        const el = doc.querySelector(sel);
        if (!el) throw new Error(`Missing input ${sel}`);
        el.focus();
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, selector, value);
    }

    async function selectValue(selector, value) {
      await waitForSelector(selector);
      await evalInApp((doc, _win, sel, val) => {
        const el = doc.querySelector(sel);
        if (!el) throw new Error(`Missing select ${sel}`);
        el.value = val;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, selector, value);
    }

    async function setHostContext(ctx) {
      await evalTop((patch) => {
        window.__sendHostContext(patch);
      }, ctx);
      await new Promise((r) => setTimeout(r, 80));
    }

    async function sendToolResult(result) {
      await evalTop((payload) => {
        window.__sendToolResult(payload);
      }, result);
      await new Promise((r) => setTimeout(r, 80));
    }

    async function setViewport(width, height) {
      await pageCdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await new Promise((r) => setTimeout(r, 80));
    }

    async function getToolCalls() {
      return evalTop(() => window.__toolCalls || []);
    }

    async function getSentMessages() {
      return evalTop(() => window.__sentMessages || []);
    }

    async function getCardInfo(pluginId) {
      return evalInApp((doc, win, id) => {
        const card = doc.querySelector(`.plugin-card[data-plugin-id="${CSS.escape(id)}"]`);
        if (!card) return { exists: false };

        const toggle =
          card.querySelector('button[role="switch"]') ||
          card.querySelector('[role="switch"]') ||
          card.querySelector('[aria-checked]');

        const manageBtn = card.querySelector('[data-action="toggle-manage-native"]');
        const nativeGuide = card.querySelector('.native-guide-box');
        const copyLinkBtn = card.querySelector('[data-action="copy-native-link"]');
        const sendChatBtn = card.querySelector('[data-action="send-native-link"]');

        const badges = Array.from(card.querySelectorAll('.badge')).map((b) =>
          (b.textContent || '').trim(),
        );
        const reinstallBtn = card.querySelector('[data-action="reinstall"]');
        const manageRect = manageBtn ? manageBtn.getBoundingClientRect() : null;

        return {
          exists: true,
          text: card.innerText || '',
          badges,
          toggleExists: Boolean(toggle),
          manageBtnExists: Boolean(manageBtn),
          manageBtnRect: manageRect
            ? {
                left: manageRect.left,
                right: manageRect.right,
                top: manageRect.top,
                bottom: manageRect.bottom,
                width: manageRect.width,
                height: manageRect.height,
              }
            : null,
          nativeGuideExists: Boolean(nativeGuide),
          nativeGuideText: nativeGuide ? nativeGuide.innerText || '' : '',
          copyLinkBtnExists: Boolean(copyLinkBtn),
          sendChatBtnExists: Boolean(sendChatBtn),
          reinstallExists: Boolean(reinstallBtn),
          reinstallDisabled: reinstallBtn ? Boolean(reinstallBtn.disabled) : false,
          viewportWidth: win.innerWidth,
          scrollWidth: doc.documentElement.scrollWidth,
        };
      }, pluginId);
    }

    async function close() {
      pageCdp.close();
      await browserCdp.send('Target.closeTarget', { targetId }).catch(() => {});
      await hostServer.close();
    }

    return {
      baseUrl: hostServer.baseUrl,
      evalTop,
      evalInApp,
      waitFor,
      waitForTop,
      waitForText,
      waitForSelector,
      click,
      setInputValue,
      selectValue,
      setHostContext,
      sendToolResult,
      setViewport,
      getToolCalls,
      getSentMessages,
      getAppText,
      getCardInfo,
      close,
    };
  }

  async function close() {
    browserCdp.close();
    if (!exited) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // Ignore
      }
      await Promise.race([
        exitPromise,
        new Promise((resolve) =>
          setTimeout(() => {
            try {
              if (!exited) proc.kill('SIGKILL');
            } catch {
              // Ignore
            }
            resolve();
          }, 3000),
        ),
      ]);
    }
    await fs.rm(userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 12,
      retryDelay: 150,
    });
  }

  return {
    browserBin,
    openAppSession,
    close,
  };
}
