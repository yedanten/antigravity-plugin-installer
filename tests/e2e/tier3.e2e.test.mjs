import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { launchHeadlessBrowser } from './helpers/browser-host.mjs';
import { spawnMcpClient } from './helpers/mcp-client.mjs';
import { spawnLockedPluginProcess } from './helpers/process-lock.mjs';
import { createSandbox } from './helpers/sandbox.mjs';

function extractAgyPluginEntry(stdout, dirName) {
  const parsed = JSON.parse(stdout);
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.plugins)
      ? parsed.plugins
      : [];
  return list.find((p) => p.name === dirName || p.dir === dirName) || null;
}

describe('Tier 3: Cross-Feature Pairwise Interactions (8 cases)', () => {
  let browser;

  before(async () => {
    browser = await launchHeadlessBrowser();
  });

  after(async () => {
    if (browser) await browser.close();
  });

  test('E2E-T3-01 (F1+F2): Strict validation + BOM .gemini-plugin/plugin.json + v2.35.1 fields + rules/AGENTS.md', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      const srcDir = await sandbox.createPluginSource('gemini-v235', {
        manifestSubdir: '.gemini-plugin',
        bom: true,
        manifest: {
          name: 'gemini-v235',
          displayName: 'Gemini v2.35.1',
          version: '1.0.0',
          category: 'developer-tools',
          extensions: ['ext-one'],
        },
        rules: { 'AGENTS.md': '# Proper rule\n' },
        mcpConfig: { mcpServers: { tool: { command: 'node', args: ['srv.js'] } } },
        sidecars: { dirs: { worker: { command: 'node', args: ['worker.js'] } } },
      });

      const agyRes = await sandbox.runAgy(['plugin', 'validate', '--strict', '--json', srcDir]);
      assert.equal(agyRes.code, 0, `${agyRes.stderr}\n${agyRes.stdout}`);
      const agyJson = JSON.parse(agyRes.stdout);
      assert.deepEqual(
        (agyJson.findings || []).filter((f) => f.severity !== 'note'),
        [],
      );

      await mcp.initialize();
      const installRes = await mcp.callTool('app_install_plugin', { source: srcDir });
      assert.equal(installRes.structuredContent.ok, true);
      const p = installRes.structuredContent.inventory.plugins.find((x) => x.dir === 'gemini-v235');
      assert.equal(p.valid, true);
      assert.ok(p.components.rules.includes('AGENTS'));
      assert.ok(p.components.sidecars.includes('worker'));
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T3-02 (F2+F3): BOM JSONC config.json + app_set_plugin_enabled + agy CLI parity', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      await sandbox.placeInstalledPlugin('global', 'bom-cfg-p');
      await sandbox.writeConfig(
        `// JSONC header\n{\n  "userSettings": { "telemetry": false },\n  "sidecars": { "worker": { "enabled": true } },\n  "plugins": {\n    "bom-cfg-p": { "enabled": true, },\n  },\n}\n`,
        { bom: true },
      );

      await mcp.initialize();
      const res = await mcp.callTool('app_set_plugin_enabled', {
        dir: 'bom-cfg-p',
        scope: 'global',
        enabled: false,
      });
      assert.equal(res.structuredContent.ok, true);

      const raw = await sandbox.readConfigRaw();
      assert.equal(raw.startsWith('\uFEFF'), false);
      const cfg = JSON.parse(raw);
      assert.deepEqual(cfg.userSettings, { telemetry: false });
      assert.deepEqual(cfg.sidecars, { worker: { enabled: true } });
      assert.equal(cfg.plugins['bom-cfg-p'].enabled, false);

      const agyList = await sandbox.runAgy(['plugin', 'list', '--json']);
      assert.equal(agyList.code, 0, agyList.stderr);
      const entry = extractAgyPluginEntry(agyList.stdout, 'bom-cfg-p');
      assert.equal(entry.enabled, false);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T3-03 (F3+F4): manifest.name !== dir + Headless Edge UI toggle + agy plugin list parity', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let session;
    try {
      await sandbox.placeInstalledPlugin('global', 'alias-dir', {
        manifest: {
          name: 'real-name',
          displayName: 'Real Name Aliased',
          version: '1.0.0',
        },
      });
      await mcp.initialize();
      session = await browser.openAppSession({ mcpClient: mcp });

      await session.clickCardToggle('global:alias-dir');
      await session.waitForToggleState('global:alias-dir', false);

      const cfg = await sandbox.readConfig();
      assert.equal(cfg.plugins['alias-dir']?.enabled, false);
      assert.equal(cfg.plugins['real-name'], undefined);

      const agyList = await sandbox.runAgy(['plugin', 'list', '--json']);
      assert.equal(agyList.code, 0, agyList.stderr);
      const entry = extractAgyPluginEntry(agyList.stdout, 'alias-dir');
      assert.ok(entry);
      assert.equal(entry.enabled, false);
    } finally {
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T3-04 (F4+F5): Headless Edge UI Update button + real child-process EBUSY lock + auto-disable/restore', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let session;
    let lock;
    try {
      const srcDir = await sandbox.createPluginSource('ui-lock-upd', {
        manifest: { name: 'ui-lock-upd', displayName: 'UI Lock Update', version: '1.0.0' },
        files: { 'marker.txt': 'v1' },
      });
      await mcp.initialize();
      await mcp.callTool('app_install_plugin', { source: srcDir });
      await mcp.callTool('app_set_plugin_enabled', {
        dir: 'ui-lock-upd',
        scope: 'global',
        enabled: true,
      });

      const installedDir = path.join(sandbox.globalPluginsDir, 'ui-lock-upd');
      lock = await spawnLockedPluginProcess({
        pluginDir: installedDir,
        configPath: sandbox.configPath,
        dirName: 'ui-lock-upd',
        releaseOnDisable: true,
        releaseDelayMs: 150,
      });
      sandbox.trackChild(lock.child);

      await sandbox.createPluginSource('ui-lock-upd', {
        targetDir: srcDir,
        manifest: { name: 'ui-lock-upd', displayName: 'UI Lock Update', version: '2.0.0' },
        files: { 'marker.txt': 'v2' },
      });

      session = await browser.openAppSession({ mcpClient: mcp });
      await session.click('.plugin-card[data-plugin-id="global:ui-lock-upd"] [data-action="reinstall"]');

      await session.waitFor(
        (doc) => {
          const card = doc.querySelector('.plugin-card[data-plugin-id="global:ui-lock-upd"]');
          return Boolean(card && card.innerText.includes('v2.0.0'));
        },
        [],
        { timeoutMs: 15000, label: 'card updated to v2.0.0' },
      );

      await lock.waitForExit(5000);
      assert.equal(lock.wasReleasedByConfigDisable(), true);

      const card = await session.getCardInfo('global:ui-lock-upd');
      assert.equal(card.ariaChecked, 'true');
      assert.ok(card.badges.some((b) => /Enabled|已启用/i.test(b)));

      const marker = await fs.readFile(path.join(installedDir, 'marker.txt'), 'utf8');
      assert.equal(marker, 'v2');
      const cfg = await sandbox.readConfig();
      assert.equal(cfg.plugins['ui-lock-upd'].enabled, true);
    } finally {
      if (lock) await lock.forceKill();
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T3-05 (F4+F6): Headless Edge UI Toggle Disable -> UI Update -> Stays Disabled', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let session;
    try {
      const srcDir = await sandbox.createPluginSource('ui-dis-upd', {
        manifest: { name: 'ui-dis-upd', displayName: 'UI Disabled Update', version: '1.0.0' },
        files: { 'marker.txt': 'v1' },
      });
      await mcp.initialize();
      await mcp.callTool('app_install_plugin', { source: srcDir });

      session = await browser.openAppSession({ mcpClient: mcp });
      await session.clickCardToggle('global:ui-dis-upd');
      await session.waitForToggleState('global:ui-dis-upd', false);

      await sandbox.createPluginSource('ui-dis-upd', {
        targetDir: srcDir,
        manifest: { name: 'ui-dis-upd', displayName: 'UI Disabled Update', version: '2.0.0' },
        files: { 'marker.txt': 'v2' },
      });

      await session.click('.plugin-card[data-plugin-id="global:ui-dis-upd"] [data-action="reinstall"]');
      await session.waitFor(
        (doc) => {
          const card = doc.querySelector('.plugin-card[data-plugin-id="global:ui-dis-upd"]');
          return Boolean(card && card.innerText.includes('v2.0.0'));
        },
        [],
        { timeoutMs: 12000, label: 'ui-dis-upd updated to v2.0.0' },
      );

      const card = await session.getCardInfo('global:ui-dis-upd');
      assert.equal(card.ariaChecked, 'false');
      assert.ok(card.badges.some((b) => /Disabled|已禁用/i.test(b)));

      const cfg = await sandbox.readConfig();
      assert.equal(cfg.plugins['ui-dis-upd'].enabled, false);
    } finally {
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T3-06 (F2+F5): Built-in ANTIGRAVITY_APP_DATA_DIR coexistence + Global enabled locked plugin update', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({
      dataDir: sandbox.dataDir,
      env: sandbox.env({}, { omitBuiltinPluginsDir: true }),
    });
    let lock;
    try {
      await sandbox.placeInstalledPlugin('builtin', 'core-bi', {
        manifest: { name: 'core-bi', displayName: 'Core Builtin', version: '1.0.0' },
        files: { 'keep.txt': 'builtin-intact' },
      });
      const srcDir = await sandbox.createPluginSource('global-upd', {
        manifest: { name: 'global-upd', displayName: 'Global Upd', version: '1.0.0' },
        files: { 'marker.txt': 'v1' },
      });
      await mcp.initialize();
      await mcp.callTool('app_install_plugin', { source: srcDir });

      const installedDir = path.join(sandbox.globalPluginsDir, 'global-upd');
      lock = await spawnLockedPluginProcess({
        pluginDir: installedDir,
        configPath: sandbox.configPath,
        dirName: 'global-upd',
        releaseOnDisable: true,
        releaseDelayMs: 150,
      });
      sandbox.trackChild(lock.child);

      await sandbox.createPluginSource('global-upd', {
        targetDir: srcDir,
        manifest: { name: 'global-upd', displayName: 'Global Upd', version: '2.0.0' },
        files: { 'marker.txt': 'v2' },
      });

      const res = await mcp.callTool('app_reinstall_plugin', {
        dir: 'global-upd',
        scope: 'global',
      });
      assert.equal(res.structuredContent.ok, true);
      await lock.waitForExit(5000);
      assert.equal(lock.wasReleasedByConfigDisable(), true);

      const bi = res.structuredContent.inventory.plugins.find((p) => p.dir === 'core-bi');
      assert.equal(bi.scope, 'builtin');
      assert.equal(bi.enabled, true);
      assert.equal(
        await fs.readFile(path.join(sandbox.builtinPluginsDir, 'core-bi', 'keep.txt'), 'utf8'),
        'builtin-intact',
      );
    } finally {
      if (lock) await lock.forceKill();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T3-07 (F3+F6): Self-disable guard + Self-update guard on sandboxed plugin-installer', async () => {
    const sandbox = await createSandbox();
    const selfCopy = await sandbox.stageSandboxedSelfCopy();
    const mcp = spawnMcpClient({
      serverEntry: selfCopy.serverEntry,
      dataDir: sandbox.dataDir,
      env: sandbox.env(),
    });
    try {
      const evilSrc = await sandbox.createPluginSource('evil-self', {
        manifest: { name: 'plugin-installer', displayName: 'Evil Self', version: '9.9.9' },
      });
      await mcp.initialize();

      const disableRes = await mcp.callTool('app_set_plugin_enabled', {
        dir: 'plugin-installer',
        scope: 'global',
        enabled: false,
      });
      assert.equal(disableRes.structuredContent.ok, false);
      assert.equal(disableRes.structuredContent.code, 'SELF_DISABLE_BLOCKED');

      const updateRes = await mcp.callTool('app_install_plugin', {
        source: evilSrc,
        targetDirName: 'plugin-installer',
        overwrite: true,
      });
      assert.equal(updateRes.structuredContent.ok, false);
      assert.equal(updateRes.structuredContent.code, 'SELF_UPDATE_BLOCKED');

      const cfg = await sandbox.readConfig();
      assert.equal(cfg.plugins['plugin-installer'].enabled, true);
      const manifest = JSON.parse(
        await fs.readFile(path.join(selfCopy.pluginDir, 'plugin.json'), 'utf8'),
      );
      assert.notEqual(manifest.version, '9.9.9');
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T3-08 (F1+F5): Validation gate during update rejects invalid mcp_config.json before auto-disable', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let lock;
    try {
      const v1Dir = await sandbox.createPluginSource('val-gate-1', {
        manifest: { name: 'val-gate', displayName: 'Val Gate', version: '1.0.0' },
        files: { 'marker.txt': 'v1-intact' },
      });
      const v2Invalid = await sandbox.createPluginSource('val-gate-2', {
        manifest: { name: 'val-gate', displayName: 'Val Gate', version: '2.0.0' },
        mcpConfig: { mcpServers: { bad: { command: 'node', url: 'https://bad.invalid' } } },
        files: { 'marker.txt': 'v2-bad' },
      });

      await mcp.initialize();
      await mcp.callTool('app_install_plugin', { source: v1Dir });
      await mcp.callTool('app_set_plugin_enabled', {
        dir: 'val-gate',
        scope: 'global',
        enabled: true,
      });

      const installedDir = path.join(sandbox.globalPluginsDir, 'val-gate');
      lock = await spawnLockedPluginProcess({
        pluginDir: installedDir,
        configPath: sandbox.configPath,
        dirName: 'val-gate',
        releaseOnDisable: true,
        releaseDelayMs: 50,
      });
      sandbox.trackChild(lock.child);

      const res = await mcp.callTool('app_install_plugin', {
        source: v2Invalid,
        overwrite: true,
      });
      assert.equal(res.structuredContent.ok, false);
      assert.match(res.structuredContent.error, /cannot specify both/i);
      assert.equal(lock.isAlive(), true);
      assert.equal(lock.wasReleasedByConfigDisable(), false);

      const marker = await fs.readFile(path.join(installedDir, 'marker.txt'), 'utf8');
      assert.equal(marker, 'v1-intact');
      const cfg = await sandbox.readConfig();
      assert.equal(cfg.plugins['val-gate'].enabled, true);
    } finally {
      if (lock) await lock.forceKill();
      await mcp.close();
      await sandbox.cleanup();
    }
  });
});
