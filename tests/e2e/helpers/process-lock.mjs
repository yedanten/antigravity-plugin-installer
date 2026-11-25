import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Spawn a real child Node process holding `cwd` and an open file descriptor inside `pluginDir`
 * so Windows `fs.rm` fails with `EBUSY`.
 *
 * When `releaseOnDisable` is true, watches `configPath` every ~20ms and releases the fd +
 * leaves `pluginDir` + exits cleanly after `releaseDelayMs` once `plugins[dirName].enabled === false`.
 */
export async function spawnLockedPluginProcess({
  pluginDir,
  lockFile = 'runtime.lock',
  configPath = '',
  dirName = '',
  releaseOnDisable = true,
  releaseDelayMs = 150,
  safetyTimeoutMs = 30000,
} = {}) {
  const lockPath = path.join(pluginDir, lockFile);
  await fs.mkdir(pluginDir, { recursive: true });

  const childScript = `
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');

    const lockPath = process.env.E2E_LOCK_PATH;
    const configPath = process.env.E2E_CONFIG_PATH || '';
    const dirName = process.env.E2E_DIR_NAME || '';
    const releaseOnDisable = process.env.E2E_RELEASE_ON_DISABLE === '1';
    const releaseDelayMs = Number(process.env.E2E_RELEASE_DELAY_MS || '150');
    const safetyTimeoutMs = Number(process.env.E2E_SAFETY_TIMEOUT_MS || '30000');

    let fd = fs.openSync(lockPath, 'a+');
    fs.writeSync(fd, 'locked\\n');

    function stripJsonc(raw) {
      return String(raw || '')
        .replace(/^\\uFEFF/, '')
        .replace(/\\/\\*[\\s\\S]*?\\*\\//g, '')
        .replace(/^\\s*\\/\\/.*$/gm, '');
    }

    let releasing = false;
    function releaseAndExit(reason) {
      if (releasing) return;
      releasing = true;
      setTimeout(() => {
        try {
          if (fd !== null) {
            fs.closeSync(fd);
            fd = null;
          }
        } catch {}
        try {
          process.chdir(os.tmpdir());
        } catch {}
        process.stdout.write(reason + '\\n');
        process.exit(0);
      }, releaseDelayMs);
    }

    let pollTimer = null;
    if (releaseOnDisable && configPath && dirName) {
      pollTimer = setInterval(() => {
        if (releasing) return;
        try {
          const raw = fs.readFileSync(configPath, 'utf8');
          const parsed = JSON.parse(stripJsonc(raw));
          if (parsed && parsed.plugins && parsed.plugins[dirName] && parsed.plugins[dirName].enabled === false) {
            clearInterval(pollTimer);
            releaseAndExit('RELEASED_ON_DISABLE');
          }
        } catch {
          // Config may not exist yet or be mid-rename
        }
      }, 20);
    }

    const keepAlive = setInterval(() => {}, 1000);
    const safety = setTimeout(() => {
      clearInterval(keepAlive);
      if (pollTimer) clearInterval(pollTimer);
      try {
        if (fd !== null) fs.closeSync(fd);
      } catch {}
      try {
        process.chdir(os.tmpdir());
      } catch {}
      process.exit(2);
    }, safetyTimeoutMs);
    safety.unref();

    process.on('SIGTERM', () => {
      try { if (fd !== null) fs.closeSync(fd); } catch {}
      try { process.chdir(os.tmpdir()); } catch {}
      process.exit(0);
    });

    process.stdout.write('READY\\n');
  `;

  const child = spawn(process.execPath, ['-e', childScript], {
    cwd: pluginDir,
    env: {
      ...process.env,
      E2E_LOCK_PATH: lockPath,
      E2E_CONFIG_PATH: configPath,
      E2E_DIR_NAME: dirName || path.basename(pluginDir),
      E2E_RELEASE_ON_DISABLE: releaseOnDisable ? '1' : '0',
      E2E_RELEASE_DELAY_MS: String(releaseDelayMs),
      E2E_SAFETY_TIMEOUT_MS: String(safetyTimeoutMs),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  let readyResolved = false;
  let releasedByDisable = false;
  let exited = false;
  let exitInfo = null;

  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      exited = true;
      exitInfo = { code, signal };
      resolve(exitInfo);
    });
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for lock child READY. Stderr: ${stderrBuf}`));
    }, 8000);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk;
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      if (stdoutBuf.includes('RELEASED_ON_DISABLE')) {
        releasedByDisable = true;
      }
      if (!readyResolved && stdoutBuf.includes('READY')) {
        readyResolved = true;
        clearTimeout(timer);
        resolve();
      }
    });

    child.on('exit', (code) => {
      if (!readyResolved) {
        clearTimeout(timer);
        reject(new Error(`Lock child exited early (${code}). Stderr: ${stderrBuf}`));
      }
    });
  });

  async function waitForExit(timeoutMs = 10000) {
    if (exited) return exitInfo;
    return Promise.race([
      exitPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Lock child did not exit within ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  }

  async function forceKill() {
    if (exited) return exitInfo;
    try {
      child.kill('SIGKILL');
    } catch {
      // Ignore
    }
    return exitPromise;
  }

  return {
    child,
    pid: child.pid,
    lockPath,
    isAlive: () => !exited,
    wasReleasedByConfigDisable: () => releasedByDisable,
    waitForExit,
    forceKill,
    tmpDirRef: os.tmpdir(),
  };
}
