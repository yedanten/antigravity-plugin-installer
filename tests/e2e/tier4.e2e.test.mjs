import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';
import { launchHeadlessBrowser } from './helpers/browser-host.mjs';
import { spawnMcpClient } from './helpers/mcp-client.mjs';
import { spawnLockedPluginProcess } from './helpers/process-lock.mjs';
import { REPO_ROOT, createSandbox } from './helpers/sandbox.mjs';

const execFileAsync = promisify(execFile);

function extractAgyPluginEntry(stdout, dirName) {
  const parsed = JSON.parse(stdout);
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.plugins)
      ? parsed.plugins
      : [];
  return list.find((p) => p.name === dirName || p.dir === dirName) || null;
}

describe('Tier 4: Real-World End-to-End Application Scenarios (6 cases)', () => {
  let browser;

  before(async () => {
    browser = await launchHeadlessBrowser();
  });

  after(async () => {
    if (browser) await browser.close();
  });

  test('E2E-T4-01: Full UI Install -> agy CLI Parity -> OS Child Lock -> UI Update -> Auto-Disable & Restore', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let session;
    let lock;
    try {
      const srcDir = await sandbox.createPluginSource('journey-one', {
        manifest: { name: 'journey-one', displayName: 'Journey One', version: '1.0.0' },
        rules: { 'AGENTS.md': '# Clean rule\n' },
        files: { 'marker.txt': 'v1' },
      });

      await mcp.initialize();
      session = await browser.openAppSession({ mcpClient: mcp });

      // Install via UI Install Modal
      await session.click('[data-action="open-modal"]');
      await session.setInputValue('#modal-source-input', srcDir);
      await session.click('#modal-submit-btn');
      await session.waitForSelector('.alert-success', { timeoutMs: 12000 });
      await session.click('.modal-footer-row [data-action="close-modal"]');

      await session.waitForSelector('.plugin-card[data-plugin-id="global:journey-one"]');

      // Verify agy strict validation and agy list parity
      const installedDir = path.join(sandbox.globalPluginsDir, 'journey-one');
      const valRes = await sandbox.runAgy(['plugin', 'validate', '--strict', installedDir]);
      assert.equal(valRes.code, 0, valRes.stderr);

      const listRes1 = await sandbox.runAgy(['plugin', 'list', '--json']);
      assert.equal(listRes1.code, 0, listRes1.stderr);
      const entry1 = extractAgyPluginEntry(listRes1.stdout, 'journey-one');
      assert.ok(entry1);
      assert.equal(entry1.enabled, true);

      // Lock the installed plugin directory with a real OS child process
      lock = await spawnLockedPluginProcess({
        pluginDir: installedDir,
        configPath: sandbox.configPath,
        dirName: 'journey-one',
        releaseOnDisable: true,
        releaseDelayMs: 150,
      });
      sandbox.trackChild(lock.child);

      // Bump source to v2.0.0 and click Update in UI
      await sandbox.createPluginSource('journey-one', {
        targetDir: srcDir,
        manifest: { name: 'journey-one', displayName: 'Journey One', version: '2.0.0' },
        rules: { 'AGENTS.md': '# Clean rule v2\n' },
        files: { 'marker.txt': 'v2' },
      });

      await session.click('.plugin-card[data-plugin-id="global:journey-one"] [data-action="reinstall"]');
      await session.waitFor(
        (doc) => {
          const card = doc.querySelector('.plugin-card[data-plugin-id="global:journey-one"]');
          return Boolean(card && card.innerText.includes('v2.0.0'));
        },
        [],
        { timeoutMs: 15000, label: 'journey-one updated to v2.0.0 in UI' },
      );

      await lock.waitForExit(5000);
      assert.equal(lock.wasReleasedByConfigDisable(), true);

      assert.equal(await fs.readFile(path.join(installedDir, 'marker.txt'), 'utf8'), 'v2');
      const card = await session.getCardInfo('global:journey-one');
      assert.equal(card.ariaChecked, 'true');

      const cfg = await sandbox.readConfig();
      assert.equal(cfg.plugins['journey-one'].enabled, true);

      const listRes2 = await sandbox.runAgy(['plugin', 'list', '--json']);
      assert.equal(extractAgyPluginEntry(listRes2.stdout, 'journey-one').enabled, true);
    } finally {
      if (lock) await lock.forceKill();
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T4-02: UI Disable -> agy Verification -> UI Update Disabled -> Re-enable in UI', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let session;
    try {
      const srcDir = await sandbox.createPluginSource('journey-two', {
        manifest: { name: 'journey-two', displayName: 'Journey Two', version: '1.0.0' },
        files: { 'marker.txt': 'v1' },
      });
      await mcp.initialize();
      await mcp.callTool('app_install_plugin', { source: srcDir });

      session = await browser.openAppSession({ mcpClient: mcp });
      await session.clickCardToggle('global:journey-two');
      await session.waitForToggleState('global:journey-two', false);

      const agy1 = await sandbox.runAgy(['plugin', 'list', '--json']);
      assert.equal(extractAgyPluginEntry(agy1.stdout, 'journey-two').enabled, false);

      await sandbox.createPluginSource('journey-two', {
        targetDir: srcDir,
        manifest: { name: 'journey-two', displayName: 'Journey Two', version: '2.0.0' },
        files: { 'marker.txt': 'v2' },
      });

      await session.click('.plugin-card[data-plugin-id="global:journey-two"] [data-action="reinstall"]');
      await session.waitFor(
        (doc) => {
          const card = doc.querySelector('.plugin-card[data-plugin-id="global:journey-two"]');
          return Boolean(card && card.innerText.includes('v2.0.0'));
        },
        [],
        { timeoutMs: 12000, label: 'journey-two updated to v2.0.0' },
      );

      const afterUpdateCard = await session.getCardInfo('global:journey-two');
      assert.equal(afterUpdateCard.ariaChecked, 'false');
      const agy2 = await sandbox.runAgy(['plugin', 'list', '--json']);
      assert.equal(extractAgyPluginEntry(agy2.stdout, 'journey-two').enabled, false);

      await session.clickCardToggle('global:journey-two');
      await session.waitForToggleState('global:journey-two', true);

      const agy3 = await sandbox.runAgy(['plugin', 'list', '--json']);
      assert.equal(extractAgyPluginEntry(agy3.stdout, 'journey-two').enabled, true);
    } finally {
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T4-03: Multi-Scope (builtin + global name!==dir + workspace BOM) Management + userSettings/sidecars Preservation', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({
      dataDir: sandbox.dataDir,
      env: sandbox.env({}, { omitBuiltinPluginsDir: true }),
    });
    let session;
    let lock;
    try {
      await sandbox.placeInstalledPlugin('builtin', 'core-bi', {
        manifest: { name: 'core-bi', displayName: 'Core Builtin', version: '1.0.0' },
      });
      await sandbox.placeInstalledPlugin('global', 'alias-folder', {
        manifest: { name: 'actual-pkg', displayName: 'Aliased Global', version: '1.0.0' },
      });
      const wsSrc = await sandbox.createPluginSource('ws-bom-src', {
        bom: true,
        manifest: { name: 'ws-bom', displayName: 'Workspace BOM', version: '1.0.0' },
        files: { 'marker.txt': 'ws-v1' },
      });

      await sandbox.writeConfig({
        userSettings: { editorFont: 'JetBrains Mono' },
        sidecars: { autoStart: true },
        plugins: {},
      });

      await mcp.initialize();
      await mcp.callTool('app_install_plugin', {
        source: wsSrc,
        scope: 'workspace',
        workspacePath: sandbox.workspaceDir,
      });

      session = await browser.openAppSession({ mcpClient: mcp });
      await session.click('[data-action="toggle-workspace-bar"]');
      await session.setInputValue('#workspace-scan-input', sandbox.workspaceDir);
      await session.click('[data-action="apply-workspace"]');
      await session.waitForSelector('.plugin-card[data-plugin-id="workspace:ws-bom"]');

      // Disable aliased global plugin
      await session.clickCardToggle('global:alias-folder');
      await session.waitForToggleState('global:alias-folder', false);

      // Lock workspace plugin & update it via UI
      const wsInstalledDir = path.join(sandbox.workspacePluginsDir, 'ws-bom');
      lock = await spawnLockedPluginProcess({
        pluginDir: wsInstalledDir,
        configPath: sandbox.configPath,
        dirName: 'ws-bom',
        releaseOnDisable: true,
        releaseDelayMs: 150,
      });
      sandbox.trackChild(lock.child);

      await sandbox.createPluginSource('ws-bom-src', {
        targetDir: wsSrc,
        bom: true,
        manifest: { name: 'ws-bom', displayName: 'Workspace BOM', version: '2.0.0' },
        files: { 'marker.txt': 'ws-v2' },
      });

      await session.click('[data-action="set-filter"][data-value="workspace"]');
      await session.click('.plugin-card[data-plugin-id="workspace:ws-bom"] [data-action="reinstall"]');
      await session.waitFor(
        (doc) => {
          const card = doc.querySelector('.plugin-card[data-plugin-id="workspace:ws-bom"]');
          return Boolean(card && card.innerText.includes('v2.0.0'));
        },
        [],
        { timeoutMs: 15000, label: 'ws-bom updated to v2.0.0' },
      );

      await lock.waitForExit(5000);
      assert.equal(lock.wasReleasedByConfigDisable(), true);
      assert.equal(await fs.readFile(path.join(wsInstalledDir, 'marker.txt'), 'utf8'), 'ws-v2');

      const cfg = await sandbox.readConfig();
      assert.deepEqual(cfg.userSettings, { editorFont: 'JetBrains Mono' });
      assert.deepEqual(cfg.sidecars, { autoStart: true });
      assert.equal(cfg.plugins['alias-folder'].enabled, false);
      assert.equal(cfg.plugins['ws-bom'].enabled, true);

      await session.click('[data-action="set-filter"][data-value="builtin"]');
      const biCard = await session.getCardInfo('builtin:core-bi');
      assert.equal(biCard.exists, true);
      assert.equal(biCard.ariaChecked, 'true');
    } finally {
      if (lock) await lock.forceKill();
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T4-04: Failed Update Recovery Journey (Broken v2 -> Preserved Lock & enabled -> Fix v2 -> Update & Restore)', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let session;
    let lock;
    try {
      const srcDir = await sandbox.createPluginSource('recover-p', {
        manifest: { name: 'recover-p', displayName: 'Recover P', version: '1.0.0' },
        files: { 'marker.txt': 'v1-intact' },
      });
      await mcp.initialize();
      await mcp.callTool('app_install_plugin', { source: srcDir });
      await mcp.callTool('app_set_plugin_enabled', {
        dir: 'recover-p',
        scope: 'global',
        enabled: true,
      });

      const installedDir = path.join(sandbox.globalPluginsDir, 'recover-p');
      lock = await spawnLockedPluginProcess({
        pluginDir: installedDir,
        configPath: sandbox.configPath,
        dirName: 'recover-p',
        releaseOnDisable: true,
        releaseDelayMs: 150,
      });
      sandbox.trackChild(lock.child);

      session = await browser.openAppSession({ mcpClient: mcp });

      // Step 1: Break v2 source manifest and attempt Update
      await sandbox.createPluginSource('recover-p', {
        targetDir: srcDir,
        rawManifest: '{ broken json',
        files: { 'marker.txt': 'v2-broken' },
      });

      await session.click('.plugin-card[data-plugin-id="global:recover-p"] [data-action="reinstall"]');
      await session.waitForSelector('.toast.error', { timeoutMs: 10000 });

      assert.equal(lock.isAlive(), true);
      assert.equal(lock.wasReleasedByConfigDisable(), false);
      assert.equal(await fs.readFile(path.join(installedDir, 'marker.txt'), 'utf8'), 'v1-intact');
      assert.equal((await sandbox.readConfig()).plugins['recover-p'].enabled, true);

      // Step 2: Fix v2 source and retry Update
      await sandbox.createPluginSource('recover-p', {
        targetDir: srcDir,
        manifest: { name: 'recover-p', displayName: 'Recover P', version: '2.0.0' },
        files: { 'marker.txt': 'v2-fixed' },
      });

      await session.click('.plugin-card[data-plugin-id="global:recover-p"] [data-action="reinstall"]');
      await session.waitFor(
        (doc) => {
          const card = doc.querySelector('.plugin-card[data-plugin-id="global:recover-p"]');
          return Boolean(card && card.innerText.includes('v2.0.0'));
        },
        [],
        { timeoutMs: 15000, label: 'recover-p updated to v2.0.0 after fix' },
      );

      await lock.waitForExit(5000);
      assert.equal(lock.wasReleasedByConfigDisable(), true);
      assert.equal(await fs.readFile(path.join(installedDir, 'marker.txt'), 'utf8'), 'v2-fixed');

      const card = await session.getCardInfo('global:recover-p');
      assert.equal(card.ariaChecked, 'true');
      assert.equal((await sandbox.readConfig()).plugins['recover-p'].enabled, true);
    } finally {
      if (lock) await lock.forceKill();
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T4-05: Repo Strict Validation Gate + Sandboxed Self-Protection vs Sibling Lifecycle', async () => {
    const sandbox = await createSandbox();
    let mcp;
    let session;
    try {
      const selfCopy = await sandbox.stageSandboxedSelfCopy();
      const agyStrict = await sandbox.runAgy(['plugin', 'validate', '--strict', '--json', selfCopy.pluginDir]);
      assert.equal(agyStrict.code, 0, agyStrict.stderr);
      const valSelf = await execFileAsync(
        process.execPath,
        [path.join(REPO_ROOT, 'scripts', 'validate-self.mjs')],
        { cwd: REPO_ROOT, env: sandbox.env(), timeout: 15000, windowsHide: true },
      );
      assert.match(valSelf.stdout, /Valid:\s+true/);
      mcp = spawnMcpClient({
        serverEntry: selfCopy.serverEntry,
        dataDir: sandbox.dataDir,
        env: sandbox.env(),
      });
      await mcp.initialize();

      const sibSrc = await sandbox.createPluginSource('sibling-p', {
        manifest: { name: 'sibling-p', displayName: 'Sibling Plugin', version: '1.0.0' },
        files: { 'marker.txt': 's1' },
      });
      const evilSelfSrc = await sandbox.createPluginSource('evil-self-v2', {
        manifest: { name: 'plugin-installer', displayName: 'Hijack', version: '9.9.9' },
      });

      session = await browser.openAppSession({ mcpClient: mcp });

      // Attempt self-disable via UI
      await session.clickCardToggle('global:plugin-installer');
      await session.waitForSelector('.toast.error');
      const selfCard = await session.getCardInfo('global:plugin-installer');
      assert.equal(selfCard.ariaChecked, 'true');

      // Attempt self-overwrite via MCP
      const selfOw = await mcp.callTool('app_install_plugin', {
        source: evilSelfSrc,
        targetDirName: 'plugin-installer',
        overwrite: true,
      });
      assert.equal(selfOw.structuredContent.ok, false);
      assert.equal(selfOw.structuredContent.code, 'SELF_UPDATE_BLOCKED');

      // Sibling full lifecycle via UI: install, disable, update, uninstall
      await session.click('[data-action="open-modal"]');
      await session.setInputValue('#modal-source-input', sibSrc);
      await session.click('#modal-submit-btn');
      await session.waitForSelector('.alert-success', { timeoutMs: 12000 });
      await session.click('.modal-footer-row [data-action="close-modal"]');
      await session.waitForSelector('.plugin-card[data-plugin-id="global:sibling-p"]');

      await session.clickCardToggle('global:sibling-p');
      await session.waitForToggleState('global:sibling-p', false);

      await sandbox.createPluginSource('sibling-p', {
        targetDir: sibSrc,
        manifest: { name: 'sibling-p', displayName: 'Sibling Plugin', version: '2.0.0' },
        files: { 'marker.txt': 's2' },
      });
      await session.click('.plugin-card[data-plugin-id="global:sibling-p"] [data-action="reinstall"]');
      await session.waitFor(
        (doc) => {
          const card = doc.querySelector('.plugin-card[data-plugin-id="global:sibling-p"]');
          return Boolean(card && card.innerText.includes('v2.0.0'));
        },
        [],
        { timeoutMs: 12000, label: 'sibling updated while staying disabled' },
      );
      assert.equal((await session.getCardInfo('global:sibling-p')).ariaChecked, 'false');

      await session.click('.plugin-card[data-plugin-id="global:sibling-p"] [data-action="ask-uninstall"]');
      await session.click('.plugin-card[data-plugin-id="global:sibling-p"] [data-action="confirm-uninstall"]');
      await session.waitFor(
        (doc) => !doc.querySelector('.plugin-card[data-plugin-id="global:sibling-p"]'),
        [],
        { label: 'sibling uninstalled' },
      );

      assert.equal((await sandbox.readConfig()).plugins['plugin-installer'].enabled, true);
    } finally {
      if (session) await session.close();
      if (mcp) await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T4-06: Bilingual zh/en Dark-Mode Narrow Aux-Pane Workflow + agy CLI Sync + Locked Update', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let session;
    let lock;
    try {
      const srcDir = await sandbox.createPluginSource('aux-p', {
        manifest: { name: 'aux-p', displayName: 'Aux Pane Plugin', version: '1.0.0' },
        files: { 'marker.txt': 'v1' },
      });
      await mcp.initialize();
      await mcp.callTool('app_install_plugin', { source: srcDir });

      session = await browser.openAppSession({
        mcpClient: mcp,
        hostContext: { theme: 'dark', locale: 'zh-CN' },
        viewport: { width: 440, height: 720 },
      });

      assert.equal(
        await session.evalInApp((doc) => doc.documentElement.getAttribute('data-theme')),
        'dark',
      );
      await session.waitForText('已启用');

      // Toggle off in Chinese UI
      await session.clickCardToggle('global:aux-p');
      await session.waitForText('已禁用');
      assert.equal(
        extractAgyPluginEntry((await sandbox.runAgy(['plugin', 'list', '--json'])).stdout, 'aux-p').enabled,
        false,
      );

      // Re-enable externally via agy CLI and refresh UI
      const agyEn = await sandbox.runAgy(['plugin', 'enable', 'aux-p']);
      assert.equal(agyEn.code, 0, agyEn.stderr);
      await session.click('[data-action="refresh"]');
      await session.waitForText('已启用');

      // Switch locale to English
      await session.click('[data-action="toggle-locale"]');
      await session.waitForText('Enabled');

      // Lock & update via narrow dark-mode English UI
      const installedDir = path.join(sandbox.globalPluginsDir, 'aux-p');
      lock = await spawnLockedPluginProcess({
        pluginDir: installedDir,
        configPath: sandbox.configPath,
        dirName: 'aux-p',
        releaseOnDisable: true,
        releaseDelayMs: 150,
      });
      sandbox.trackChild(lock.child);

      await sandbox.createPluginSource('aux-p', {
        targetDir: srcDir,
        manifest: { name: 'aux-p', displayName: 'Aux Pane Plugin', version: '2.0.0' },
        files: { 'marker.txt': 'v2' },
      });

      await session.click('.plugin-card[data-plugin-id="global:aux-p"] [data-action="reinstall"]');
      await session.waitFor(
        (doc) => {
          const card = doc.querySelector('.plugin-card[data-plugin-id="global:aux-p"]');
          return Boolean(card && card.innerText.includes('v2.0.0'));
        },
        [],
        { timeoutMs: 15000, label: 'aux-p updated to v2.0.0' },
      );

      await lock.waitForExit(5000);
      assert.equal(lock.wasReleasedByConfigDisable(), true);

      const finalCard = await session.getCardInfo('global:aux-p');
      assert.equal(finalCard.ariaChecked, 'true');
      assert.ok(finalCard.toggleRect.right <= finalCard.viewportWidth + 1);
      assert.ok(finalCard.scrollWidth <= finalCard.viewportWidth + 1);
      assert.equal(
        extractAgyPluginEntry((await sandbox.runAgy(['plugin', 'list', '--json'])).stdout, 'aux-p').enabled,
        true,
      );
    } finally {
      if (lock) await lock.forceKill();
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });
});
