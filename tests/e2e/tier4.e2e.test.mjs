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

  test('E2E-T4-01: Full UI Install -> agy Parity -> Locked Update Guidance -> Stop Process -> UI Update Succeeds', async () => {
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

      // Lock the installed plugin directory (simulating a running MCP server / sidecar)
      lock = await spawnLockedPluginProcess({
        pluginDir: installedDir,
        releaseOnDisable: false,
      });
      sandbox.trackChild(lock.child);

      // Bump source to v2.0.0 and click Update in UI -> should fail safely with native Customizations guide
      await sandbox.createPluginSource('journey-one', {
        targetDir: srcDir,
        manifest: { name: 'journey-one', displayName: 'Journey One', version: '2.0.0' },
        rules: { 'AGENTS.md': '# Clean rule v2\n' },
        files: { 'marker.txt': 'v2' },
      });

      await session.click('.plugin-card[data-plugin-id="global:journey-one"] [data-action="reinstall"]');
      await session.waitForSelector('.toast.error', { timeoutMs: 15000 });
      await session.waitForSelector('.plugin-card[data-plugin-id="global:journey-one"] .native-guide-box');
      assert.equal(await fs.readFile(path.join(installedDir, 'marker.txt'), 'utf8'), 'v1');
      await assert.rejects(() => fs.stat(sandbox.configPath), { code: 'ENOENT' });

      // Simulate user stopping/disabling the plugin in native Customizations -> retry Update succeeds
      await lock.forceKill();
      lock = null;

      await session.click('.plugin-card[data-plugin-id="global:journey-one"] [data-action="reinstall"]');
      await session.waitFor(
        (doc) => {
          const card = doc.querySelector('.plugin-card[data-plugin-id="global:journey-one"]');
          return Boolean(card && card.innerText.includes('v2.0.0'));
        },
        [],
        { timeoutMs: 15000, label: 'journey-one updated to v2.0.0 in UI' },
      );

      assert.equal(await fs.readFile(path.join(installedDir, 'marker.txt'), 'utf8'), 'v2');
      await assert.rejects(() => fs.stat(sandbox.configPath), { code: 'ENOENT' });
    } finally {
      if (lock) await lock.forceKill();
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T4-02: External agy Disable -> UI Refresh -> UI Update Preserves Disabled -> External Re-enable -> UI Refresh', async () => {
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

      // External disable via agy CLI (simulating native state change)
      assert.equal((await sandbox.runAgy(['plugin', 'disable', 'journey-two'])).code, 0);
      await session.click('[data-action="refresh"]');
      await session.waitForText('Disabled');
      const cfgAfterDis = await sandbox.readConfigRaw();

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
      assert.ok(afterUpdateCard.badges.includes('Disabled'));
      assert.equal(await sandbox.readConfigRaw(), cfgAfterDis);

      // External re-enable & UI refresh
      assert.equal((await sandbox.runAgy(['plugin', 'enable', 'journey-two'])).code, 0);
      await session.click('[data-action="refresh"]');
      await session.waitForText('Enabled');
    } finally {
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T4-03: Multi-Scope (builtin + global name!==dir + workspace BOM) Management + Untouched userSettings/sidecars', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({
      dataDir: sandbox.dataDir,
      env: sandbox.env({}, { omitBuiltinPluginsDir: true }),
    });
    let session;
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

      const initialCfg = JSON.stringify(
        {
          userSettings: { editorFont: 'JetBrains Mono' },
          sidecars: { autoStart: true },
          plugins: { 'alias-folder': { enabled: false } },
        },
        null,
        2,
      );
      await sandbox.writeConfig(initialCfg);

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

      const aliasCard = await session.getCardInfo('global:alias-folder');
      assert.ok(aliasCard.badges.includes('Disabled'));

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

      assert.equal(
        await fs.readFile(path.join(sandbox.workspacePluginsDir, 'ws-bom', 'marker.txt'), 'utf8'),
        'ws-v2',
      );
      // config.json must remain byte-for-byte untouched
      assert.equal(await sandbox.readConfigRaw(), initialCfg);

      await session.click('[data-action="set-filter"][data-value="builtin"]');
      const biCard = await session.getCardInfo('builtin:core-bi');
      assert.equal(biCard.exists, true);
      assert.ok(biCard.badges.includes('Enabled'));
    } finally {
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T4-04: Failed Update Recovery Journey (Broken v2 -> Preserved v1 & config.json -> Fix v2 -> Update Succeeds)', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let session;
    try {
      const srcDir = await sandbox.createPluginSource('recover-p', {
        manifest: { name: 'recover-p', displayName: 'Recover P', version: '1.0.0' },
        files: { 'marker.txt': 'v1-intact' },
      });
      const initialCfg = JSON.stringify({ plugins: { 'recover-p': { enabled: true } } }, null, 2);
      await sandbox.writeConfig(initialCfg);
      await mcp.initialize();
      await mcp.callTool('app_install_plugin', { source: srcDir });

      const installedDir = path.join(sandbox.globalPluginsDir, 'recover-p');
      session = await browser.openAppSession({ mcpClient: mcp });

      // Step 1: Break v2 source manifest and attempt Update
      await sandbox.createPluginSource('recover-p', {
        targetDir: srcDir,
        rawManifest: '{ broken json',
        files: { 'marker.txt': 'v2-broken' },
      });

      await session.click('.plugin-card[data-plugin-id="global:recover-p"] [data-action="reinstall"]');
      await session.waitForSelector('.toast.error', { timeoutMs: 10000 });
      assert.equal(await fs.readFile(path.join(installedDir, 'marker.txt'), 'utf8'), 'v1-intact');
      assert.equal(await sandbox.readConfigRaw(), initialCfg);

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

      assert.equal(await fs.readFile(path.join(installedDir, 'marker.txt'), 'utf8'), 'v2-fixed');
      assert.equal(await sandbox.readConfigRaw(), initialCfg);
    } finally {
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

      // Attempt self-overwrite and self-uninstall via MCP
      const selfOw = await mcp.callTool('app_install_plugin', {
        source: evilSelfSrc,
        targetDirName: 'plugin-installer',
        overwrite: true,
      });
      assert.equal(selfOw.structuredContent.ok, false);
      assert.equal(selfOw.structuredContent.code, 'SELF_UPDATE_BLOCKED');

      const selfUn = await mcp.callTool('app_uninstall_plugin', {
        dir: 'plugin-installer',
        scope: 'global',
      });
      assert.equal(selfUn.structuredContent.ok, false);
      assert.equal(selfUn.structuredContent.code, 'SELF_UNINSTALL_BLOCKED');

      // Sibling full lifecycle via UI: install, native guide, update, uninstall
      await session.click('[data-action="open-modal"]');
      await session.setInputValue('#modal-source-input', sibSrc);
      await session.click('#modal-submit-btn');
      await session.waitForSelector('.alert-success', { timeoutMs: 12000 });
      await session.click('.modal-footer-row [data-action="close-modal"]');
      await session.waitForSelector('.plugin-card[data-plugin-id="global:sibling-p"]');

      await session.click('.plugin-card[data-plugin-id="global:sibling-p"] [data-action="toggle-manage-native"]');
      await session.waitForSelector('.plugin-card[data-plugin-id="global:sibling-p"] .native-guide-box');

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
        { timeoutMs: 12000, label: 'sibling updated' },
      );

      await session.click('.plugin-card[data-plugin-id="global:sibling-p"] [data-action="ask-uninstall"]');
      await session.click('.plugin-card[data-plugin-id="global:sibling-p"] [data-action="confirm-uninstall"]');
      await session.waitFor(
        (doc) => !doc.querySelector('.plugin-card[data-plugin-id="global:sibling-p"]'),
        [],
        { label: 'sibling uninstalled' },
      );
    } finally {
      if (session) await session.close();
      if (mcp) await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T4-06: Bilingual zh/en Dark-Mode Narrow Aux-Pane Workflow + Chat Jump Link + External Sync', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let session;
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
        hostCapabilities: { serverTools: {}, openLinks: {}, message: {} },
        viewport: { width: 440, height: 720 },
      });

      assert.equal(
        await session.evalInApp((doc) => doc.documentElement.getAttribute('data-theme')),
        'dark',
      );
      await session.waitForText('已启用');

      // Open native management guide & send customization://aux-p link to chat
      await session.click('.plugin-card[data-plugin-id="global:aux-p"] [data-action="toggle-manage-native"]');
      await session.waitForSelector('.plugin-card[data-plugin-id="global:aux-p"] [data-action="send-native-link"]');
      await session.click('.plugin-card[data-plugin-id="global:aux-p"] [data-action="send-native-link"]');
      await session.waitForSelector('.toast');

      const sent = await session.getSentMessages();
      assert.equal(sent.length, 1);
      assert.match(JSON.stringify(sent[0]), /customization:\/\/aux-p/);

      // External disable via agy CLI and refresh UI
      assert.equal((await sandbox.runAgy(['plugin', 'disable', 'aux-p'])).code, 0);
      await session.click('[data-action="refresh"]');
      await session.waitForText('已禁用');

      // Re-enable externally via agy CLI and refresh UI
      assert.equal((await sandbox.runAgy(['plugin', 'enable', 'aux-p'])).code, 0);
      await session.click('[data-action="refresh"]');
      await session.waitForText('已启用');

      // Switch locale to English
      await session.click('[data-action="toggle-locale"]');
      await session.waitForText('Enabled');

      // Update via narrow dark-mode English UI
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

      const finalCard = await session.getCardInfo('global:aux-p');
      assert.equal(finalCard.toggleExists, false);
      assert.ok(finalCard.manageBtnRect.right <= finalCard.viewportWidth + 1);
      assert.ok(finalCard.scrollWidth <= finalCard.viewportWidth + 1);
      assert.equal(
        extractAgyPluginEntry((await sandbox.runAgy(['plugin', 'list', '--json'])).stdout, 'aux-p').enabled,
        true,
      );
    } finally {
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });
});
