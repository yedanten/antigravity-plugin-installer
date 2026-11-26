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
import { stageDeployablePlugin } from '../../scripts/install-local.mjs';

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

describe('Tier 1: Core Happy Paths & State Transitions (32 cases)', () => {
  let browser;

  before(async () => {
    browser = await launchHeadlessBrowser();
  });

  after(async () => {
    if (browser) await browser.close();
  });

  // =========================================================================
  // F1: R1.1 Strict CLI validation & root layout (5 cases)
  // =========================================================================

  test('E2E-T1-F1-01: Real repo passes agy plugin validate --strict --json', async () => {
    const sandbox = await createSandbox();
    const stagedDir = await stageDeployablePlugin(REPO_ROOT);
    try {
      const res = await sandbox.runAgy([
        'plugin',
        'validate',
        '--strict',
        '--json',
        stagedDir,
      ]);
      assert.equal(res.code, 0, `agy validate failed: ${res.stderr}\n${res.stdout}`);
      const json = JSON.parse(res.stdout);
      assert.equal(json.name, 'plugin-installer');
      assert.deepEqual(json.findings || [], []);
    } finally {
      await fs.rm(stagedDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      await sandbox.cleanup();
    }
  });

  test('E2E-T1-F1-02: Real repo passes npm run validate:plugin (scripts/validate-self.mjs)', async () => {
    const sandbox = await createSandbox();
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [path.join(REPO_ROOT, 'scripts', 'validate-self.mjs')],
        { cwd: REPO_ROOT, env: sandbox.env(), timeout: 15000, windowsHide: true },
      );
      assert.match(stdout, /Valid:\s+true/);
      assert.match(stdout, /Name:\s+plugin-installer/);
      assert.equal(stderr.trim(), '');
    } finally {
      await sandbox.cleanup();
    }
  });

  test('E2E-T1-F1-03: Plugin with properly placed rules/AGENTS.md passes strict validation & MCP install', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      const srcDir = await sandbox.createPluginSource('ruled-plugin', {
        manifest: { name: 'ruled-plugin', displayName: 'Ruled Plugin', version: '1.0.0' },
        rules: { 'AGENTS.md': '# Plugin rule\nFollow rules.\n' },
      });

      const agyRes = await sandbox.runAgy(['plugin', 'validate', '--strict', '--json', srcDir]);
      assert.equal(agyRes.code, 0, `agy strict failed: ${agyRes.stderr}\n${agyRes.stdout}`);
      const agyJson = JSON.parse(agyRes.stdout);
      assert.deepEqual(
        (agyJson.findings || []).filter((f) => f.severity !== 'note'),
        [],
      );

      await mcp.initialize();
      const installRes = await mcp.callTool('app_install_plugin', { source: srcDir });
      assert.equal(installRes.structuredContent.ok, true);
      const listRes = await mcp.callTool('app_list_plugins', {});
      const plugin = listRes.structuredContent.plugins.find((p) => p.dir === 'ruled-plugin');
      assert.ok(plugin);
      assert.equal(plugin.valid, true);
      assert.deepEqual(plugin.warnings, []);
      assert.ok(plugin.components.rules.includes('AGENTS'));
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T1-F1-04: Plugin with mcp_config.json, skills/*/SKILL.md, and agents/*.md passes strict validation', async () => {
    const sandbox = await createSandbox();
    try {
      const srcDir = await sandbox.createPluginSource('full-kit', {
        manifest: { name: 'full-kit', displayName: 'Full Kit', version: '1.2.0' },
        mcpConfig: { mcpServers: { helper: { command: 'node', args: ['index.js'] } } },
        skills: ['greet'],
        agents: ['reviewer'],
      });

      const agyRes = await sandbox.runAgy(['plugin', 'validate', '--strict', '--json', srcDir]);
      assert.equal(agyRes.code, 0, `agy strict failed: ${agyRes.stderr}\n${agyRes.stdout}`);
      const agyJson = JSON.parse(agyRes.stdout);
      assert.equal(agyJson.components.mcpServers, 1);
      assert.equal(agyJson.components.skills, 1);
      assert.equal(agyJson.components.agents, 1);
      assert.deepEqual(
        (agyJson.findings || []).filter((f) => f.severity !== 'note'),
        [],
      );
    } finally {
      await sandbox.cleanup();
    }
  });

  test('E2E-T1-F1-05: MCP handshake, resources/read app.html bundle, and tools/list visibility contract', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      const init1 = await mcp.initialize('2025-11-25');
      assert.equal(init1.protocolVersion, '2025-11-25');
      assert.equal(init1.serverInfo.name, 'plugin-installer');

      const pingRes = await mcp.ping();
      assert.deepEqual(pingRes, {});

      const resources = await mcp.listResources();
      assert.ok(resources.some((r) => r.uri === 'ui://plugin-installer/app.html'));

      const readRes = await mcp.readResource('ui://plugin-installer/app.html');
      assert.equal(readRes.contents[0].mimeType, 'text/html;profile=mcp-app');
      assert.ok(readRes.contents[0].text.includes('<div id="app">'));
      assert.ok(readRes.contents[0].text.includes('<script'));
      assert.ok(readRes.contents[0].text.includes('<style'));

      const tools = await mcp.listTools();
      const byName = new Map(tools.map((t) => [t.name, t]));
      for (const modelTool of ['open_plugin_installer', 'install_plugin']) {
        assert.ok(byName.has(modelTool), `Missing model tool ${modelTool}`);
        assert.equal(byName.get(modelTool)._meta?.ui?.visibility, undefined);
      }
      for (const appTool of [
        'app_list_plugins',
        'app_preview_source',
        'app_install_plugin',
        'app_uninstall_plugin',
        'app_reinstall_plugin',
      ]) {
        assert.ok(byName.has(appTool), `Missing app-only tool ${appTool}`);
        assert.deepEqual(byName.get(appTool)._meta?.ui?.visibility, ['app']);
      }
      assert.equal(
        byName.has('app_set_plugin_enabled'),
        false,
        'app_set_plugin_enabled must not be exposed because direct config.json edits bypass Language Server live reload',
      );
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  // =========================================================================
  // F2: R1.2 BOM-tolerant JSONC & v2.35.1 discovery (6 cases)
  // =========================================================================

  test('E2E-T1-F2-01: UTF-8 BOM-prefixed plugin.json is discovered and valid', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      await sandbox.placeInstalledPlugin('global', 'bom-plugin', {
        bom: true,
        manifest: {
          name: 'bom-plugin',
          displayName: 'BOM Plugin',
          version: '2.1.0',
          description: 'Has UTF-8 BOM',
        },
      });
      await mcp.initialize();
      const res = await mcp.callTool('app_list_plugins', {});
      const plugin = res.structuredContent.plugins.find((p) => p.dir === 'bom-plugin');
      assert.ok(plugin);
      assert.equal(plugin.valid, true);
      assert.equal(plugin.name, 'bom-plugin');
      assert.equal(plugin.displayName, 'BOM Plugin');
      assert.equal(plugin.version, '2.1.0');
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T1-F2-02: UTF-8 BOM-prefixed config.json with JSONC comments & trailing commas parsed accurately', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      await sandbox.placeInstalledPlugin('global', 'p1', {
        manifest: { name: 'p1', displayName: 'Plugin One', version: '1.0.0' },
      });
      await sandbox.writeConfig(
        `// Top comment\n{\n  "plugins": {\n    "p1": {\n      "enabled": false,\n    },\n  },\n}\n`,
        { bom: true },
      );

      await mcp.initialize();
      const res = await mcp.callTool('app_list_plugins', {});
      const p1 = res.structuredContent.plugins.find((p) => p.dir === 'p1');
      assert.ok(p1);
      assert.equal(p1.enabled, false);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T1-F2-03: .gemini-plugin/plugin.json manifest location discovered by server and agy CLI', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      const pluginDir = await sandbox.placeInstalledPlugin('global', 'gemini-manifest-p', {
        manifestSubdir: '.gemini-plugin',
        manifest: {
          name: 'gemini-manifest-p',
          displayName: 'Gemini Manifest Plugin',
          version: '1.0.0',
        },
      });

      const agyRes = await sandbox.runAgy(['plugin', 'validate', '--strict', '--json', pluginDir]);
      assert.equal(agyRes.code, 0, `agy failed on .gemini-plugin: ${agyRes.stderr}`);

      await mcp.initialize();
      const res = await mcp.callTool('app_list_plugins', {});
      const plugin = res.structuredContent.plugins.find((p) => p.dir === 'gemini-manifest-p');
      assert.ok(plugin);
      assert.equal(plugin.valid, true);
      assert.equal(plugin.displayName, 'Gemini Manifest Plugin');
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T1-F2-04: Manifest with v2.35.1 fields (category, extensions, sidecars, mcp_config.json) accepted', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      await sandbox.placeInstalledPlugin('global', 'v235-kit', {
        manifest: {
          name: 'v235-kit',
          displayName: 'v2.35.1 Kit',
          version: '1.0.0',
          category: 'productivity',
          extensions: ['ext-alpha'],
        },
        mcpConfig: {
          mcpServers: {
            srv: { command: 'node', args: ['server.js'] },
          },
        },
        sidecars: {
          dirs: {
            daemon: { name: 'daemon', command: 'node' },
          },
        },
      });

      await mcp.initialize();
      const res = await mcp.callTool('app_list_plugins', {});
      const plugin = res.structuredContent.plugins.find((p) => p.dir === 'v235-kit');
      assert.ok(plugin);
      assert.equal(plugin.valid, true);
      assert.deepEqual(plugin.errors, []);
      assert.ok(plugin.components.mcpServers.includes('srv'));
      assert.ok(plugin.components.sidecars.includes('daemon'));
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T1-F2-05: Built-in plugins discovered via ANTIGRAVITY_APP_DATA_DIR', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({
      dataDir: sandbox.dataDir,
      env: sandbox.env({}, { omitBuiltinPluginsDir: true }),
    });
    try {
      await sandbox.placeInstalledPlugin('builtin', 'b1', {
        manifest: { name: 'b1', displayName: 'Built-in B1', version: '1.0.0' },
      });

      await mcp.initialize();
      const res = await mcp.callTool('app_list_plugins', {});
      const b1 = res.structuredContent.plugins.find((p) => p.dir === 'b1');
      assert.ok(b1);
      assert.equal(b1.scope, 'builtin');
      assert.equal(b1.isBuiltin, true);
      assert.equal(b1.canUninstall, false);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T1-F2-06: ANTIGRAVITY_PLUGINS_DIR and workspace .agents/plugins discovery counts accurately', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      await sandbox.placeInstalledPlugin('global', 'g1');
      await sandbox.placeInstalledPlugin('global', 'g2');
      await sandbox.placeInstalledPlugin('workspace', 'w1');
      await sandbox.placeInstalledPlugin('builtin', 'b1');

      await mcp.initialize();
      const res = await mcp.callTool('app_list_plugins', {
        workspacePath: sandbox.workspaceDir,
      });
      assert.deepEqual(res.structuredContent.counts, {
        total: 4,
        global: 2,
        workspace: 1,
        builtin: 1,
      });
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  // =========================================================================
  // F3: Read-only config.json parity & customization://<dir> contract (5 cases)
  // =========================================================================

  test('E2E-T1-F3-01: app_list_plugins reads disabled global plugin state from config.json without mutating it', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      await sandbox.placeInstalledPlugin('global', 'p1');
      const rawCfg = JSON.stringify({ plugins: { p1: { enabled: false } } }, null, 2);
      await sandbox.writeConfig(rawCfg);
      await mcp.initialize();

      const res = await mcp.callTool('app_list_plugins', {});
      const p1 = res.structuredContent.plugins.find((p) => p.dir === 'p1');
      assert.equal(p1.enabled, false);
      assert.equal(p1.customizationUri, 'customization://p1');
      assert.equal(await sandbox.readConfigRaw(), rawCfg);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T1-F3-02: app_list_plugins reads enabled/disabled states across workspace and built-in scopes', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      await sandbox.placeInstalledPlugin('workspace', 'ws-p');
      await sandbox.placeInstalledPlugin('builtin', 'bi-p');
      const rawCfg = JSON.stringify(
        { plugins: { 'ws-p': { enabled: false }, 'bi-p': { enabled: false } } },
        null,
        2,
      );
      await sandbox.writeConfig(rawCfg);
      await mcp.initialize();

      const res = await mcp.callTool('app_list_plugins', {
        workspacePath: sandbox.workspaceDir,
      });
      const ws = res.structuredContent.plugins.find((p) => p.id === 'workspace:ws-p');
      const bi = res.structuredContent.plugins.find((p) => p.id === 'builtin:bi-p');
      assert.equal(ws.enabled, false);
      assert.equal(ws.customizationUri, 'customization://ws-p');
      assert.equal(bi.enabled, false);
      assert.equal(bi.customizationUri, 'customization://bi-p');
      assert.equal(await sandbox.readConfigRaw(), rawCfg);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T1-F3-03: app_list_plugins keys enablement & customizationUri by dir when manifest.name !== dir', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      await sandbox.placeInstalledPlugin('global', 'custom-dir', {
        manifest: {
          name: 'actual-name',
          displayName: 'Actual Name',
          version: '1.0.0',
        },
      });
      await sandbox.writeConfig({ plugins: { 'custom-dir': { enabled: false } } });

      await mcp.initialize();
      const res = await mcp.callTool('app_list_plugins', {});
      const plugin = res.structuredContent.plugins.find((p) => p.dir === 'custom-dir');
      assert.equal(plugin.enabled, false);
      assert.equal(plugin.customizationUri, 'customization://custom-dir');

      const agyList = await sandbox.runAgy(['plugin', 'list', '--json']);
      assert.equal(agyList.code, 0, agyList.stderr);
      const agyEntry = extractAgyPluginEntry(agyList.stdout, 'custom-dir');
      assert.ok(agyEntry, `Expected custom-dir in agy list: ${agyList.stdout}`);
      assert.equal(agyEntry.enabled, false);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T1-F3-04: app_list_plugins honors custom ANTIGRAVITY_CONFIG_PATH read-only', async () => {
    const sandbox = await createSandbox();
    const customConfigPath = path.join(sandbox.root, 'alt', 'my-config.json');
    const mcp = spawnMcpClient({
      dataDir: sandbox.dataDir,
      env: sandbox.env({ ANTIGRAVITY_CONFIG_PATH: customConfigPath }),
    });
    try {
      await sandbox.placeInstalledPlugin('global', 'p1');
      await fs.mkdir(path.dirname(customConfigPath), { recursive: true });
      await fs.writeFile(customConfigPath, JSON.stringify({ plugins: { p1: { enabled: false } } }), 'utf8');
      await mcp.initialize();

      const res = await mcp.callTool('app_list_plugins', {});
      assert.equal(res.structuredContent.plugins.find((p) => p.dir === 'p1').enabled, false);
      await assert.rejects(() => fs.stat(sandbox.configPath), { code: 'ENOENT' });
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  // =========================================================================
  // F4: UI read-only status, native Customizations guide & live sync (5 cases)
  // =========================================================================

  test('E2E-T1-F4-01: Headless Edge renders accurate read-only status badges without broken toggle switches', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let session;
    try {
      await sandbox.placeInstalledPlugin('global', 'p-enabled', {
        manifest: { name: 'p-enabled', displayName: 'Plugin Enabled', version: '1.0.0' },
      });
      await sandbox.placeInstalledPlugin('global', 'p-disabled', {
        manifest: { name: 'p-disabled', displayName: 'Plugin Disabled', version: '1.0.0' },
      });
      await sandbox.writeConfig({ plugins: { 'p-disabled': { enabled: false } } });
      await mcp.initialize();

      session = await browser.openAppSession({ mcpClient: mcp });
      const card1 = await session.getCardInfo('global:p-enabled');
      const card2 = await session.getCardInfo('global:p-disabled');

      assert.equal(card1.exists, true);
      assert.equal(card1.toggleExists, false);
      assert.equal(card1.manageBtnExists, true);
      assert.ok(card1.badges.some((b) => /Enabled|已启用/i.test(b)));

      assert.equal(card2.exists, true);
      assert.equal(card2.toggleExists, false);
      assert.equal(card2.manageBtnExists, true);
      assert.ok(card2.badges.some((b) => /Disabled|已禁用/i.test(b)));
    } finally {
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T1-F4-02: Native Customizations guide shows customization://<dir> and hides chat button in global view', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let session;
    try {
      await sandbox.placeInstalledPlugin('global', 'p1', {
        manifest: { name: 'p1', displayName: 'Plugin One', version: '1.0.0' },
      });
      await mcp.initialize();
      session = await browser.openAppSession({
        mcpClient: mcp,
        hostCapabilities: { serverTools: {}, openLinks: {} },
      });

      await session.click('.plugin-card[data-plugin-id="global:p1"] [data-action="toggle-manage-native"]');
      await session.waitForSelector('.plugin-card[data-plugin-id="global:p1"] .native-guide-box');

      const card = await session.getCardInfo('global:p1');
      assert.equal(card.nativeGuideExists, true);
      assert.ok(card.nativeGuideText.includes('customization://p1'));
      assert.equal(card.copyLinkBtnExists, true);
      assert.equal(card.sendChatBtnExists, false);
    } finally {
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T1-F4-03: Aux-pane view with message capability sends customization://<dir> link to chat', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let session;
    try {
      await sandbox.placeInstalledPlugin('global', 'p2', {
        manifest: { name: 'p2', displayName: 'Plugin Two', version: '1.0.0' },
      });
      await mcp.initialize();
      session = await browser.openAppSession({
        mcpClient: mcp,
        hostCapabilities: { serverTools: {}, openLinks: {}, message: {} },
      });

      await session.click('.plugin-card[data-plugin-id="global:p2"] [data-action="toggle-manage-native"]');
      await session.waitForSelector('.plugin-card[data-plugin-id="global:p2"] [data-action="send-native-link"]');
      await session.click('.plugin-card[data-plugin-id="global:p2"] [data-action="send-native-link"]');
      await session.waitForSelector('.toast');

      const sent = await session.getSentMessages();
      assert.equal(sent.length, 1);
      assert.match(JSON.stringify(sent[0]), /customization:\/\/p2/);
    } finally {
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T1-F4-04: UI Refresh button syncs external agy plugin disable changes', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let session;
    try {
      await sandbox.placeInstalledPlugin('global', 'p1', {
        manifest: { name: 'p1', displayName: 'Plugin One', version: '1.0.0' },
      });
      await mcp.initialize();
      session = await browser.openAppSession({ mcpClient: mcp });

      const initialCard = await session.getCardInfo('global:p1');
      assert.ok(initialCard.badges.includes('Enabled'));

      const agyRes = await sandbox.runAgy(['plugin', 'disable', 'p1']);
      assert.equal(agyRes.code, 0, agyRes.stderr);

      await session.click('[data-action="refresh"]');
      await session.waitForText('Disabled');
      const updatedCard = await session.getCardInfo('global:p1');
      assert.ok(updatedCard.badges.includes('Disabled'));
    } finally {
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T1-F4-05: Bilingual zh/en toggle renders localized status, update & native management labels', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let session;
    try {
      const srcDir = await sandbox.createPluginSource('bilingual-p', {
        manifest: { name: 'bilingual-p', displayName: 'Bilingual Plugin', version: '1.0.0' },
      });
      await mcp.initialize();
      await mcp.callTool('app_install_plugin', { source: srcDir });

      session = await browser.openAppSession({
        mcpClient: mcp,
        hostContext: { theme: 'light', locale: 'en-US' },
      });

      const enCard = await session.getCardInfo('global:bilingual-p');
      assert.ok(enCard.badges.includes('Enabled'));
      assert.ok(enCard.text.includes('Update'));
      assert.ok(enCard.text.includes('Enable / Disable'));

      await session.click('[data-action="toggle-locale"]');
      await session.waitForText('已启用');

      const zhCard = await session.getCardInfo('global:bilingual-p');
      assert.ok(zhCard.badges.includes('已启用'));
      assert.ok(zhCard.text.includes('更新'));
      assert.ok(zhCard.text.includes('原生启停'));
    } finally {
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  // =========================================================================
  // F5: Atomic Update & File-Lock Safety without touching config.json (4 cases)
  // =========================================================================

  test('E2E-T1-F5-01: app_reinstall_plugin replaces files cleanly without modifying config.json', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      const srcDir = await sandbox.createPluginSource('upd-p', {
        manifest: { name: 'upd-p', displayName: 'Upd P', version: '1.0.0' },
        files: { 'marker.txt': 'v1' },
      });
      const initialCfg = JSON.stringify({ userSettings: { keep: 1 }, plugins: { 'upd-p': { enabled: true } } }, null, 2);
      await sandbox.writeConfig(initialCfg);
      await mcp.initialize();
      await mcp.callTool('app_install_plugin', { source: srcDir });

      await sandbox.createPluginSource('upd-p', {
        targetDir: srcDir,
        manifest: { name: 'upd-p', displayName: 'Upd P', version: '2.0.0' },
        files: { 'marker.txt': 'v2' },
      });

      const res = await mcp.callTool('app_reinstall_plugin', { dir: 'upd-p', scope: 'global' });
      assert.equal(res.structuredContent.ok, true);
      assert.equal(res.structuredContent.install.overwrote, true);
      assert.equal(res.structuredContent.install.enabled, true);

      const marker = await fs.readFile(path.join(sandbox.globalPluginsDir, 'upd-p', 'marker.txt'), 'utf8');
      assert.equal(marker, 'v2');
      assert.equal(await sandbox.readConfigRaw(), initialCfg);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T1-F5-02: app_reinstall_plugin on locked plugin returns actionable customizationUri guidance without mutating files or config.json', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let lock;
    try {
      const srcDir = await sandbox.createPluginSource('locked-p', {
        manifest: { name: 'locked-p', displayName: 'Locked P', version: '1.0.0' },
        files: { 'marker.txt': 'v1' },
      });
      const initialCfg = JSON.stringify({ plugins: { 'locked-p': { enabled: true } } }, null, 2);
      await sandbox.writeConfig(initialCfg);
      await mcp.initialize();
      await mcp.callTool('app_install_plugin', { source: srcDir });

      const installedDir = path.join(sandbox.globalPluginsDir, 'locked-p');
      lock = await spawnLockedPluginProcess({
        pluginDir: installedDir,
        releaseOnDisable: false,
      });
      sandbox.trackChild(lock.child);

      await sandbox.createPluginSource('locked-p', {
        targetDir: srcDir,
        manifest: { name: 'locked-p', displayName: 'Locked P', version: '2.0.0' },
        files: { 'marker.txt': 'v2' },
      });

      const res = await mcp.callTool(
        'app_reinstall_plugin',
        { dir: 'locked-p', scope: 'global' },
        { timeoutMs: 15000 },
      );
      assert.equal(res.structuredContent.ok, false);
      assert.equal(res.structuredContent.locked, true);
      assert.equal(res.structuredContent.customizationUri, 'customization://locked-p');
      assert.match(res.structuredContent.error, /customization:\/\/locked-p/);
      assert.equal(await fs.readFile(path.join(installedDir, 'marker.txt'), 'utf8'), 'v1');
      assert.equal(await sandbox.readConfigRaw(), initialCfg);
    } finally {
      if (lock) await lock.forceKill();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T1-F5-03: Model-visible install_plugin with overwrite: true replaces files cleanly without mutating config.json', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      const v1Dir = await sandbox.createPluginSource('model-v1', {
        manifest: { name: 'model-ow', displayName: 'Model OW', version: '1.0.0' },
        files: { 'marker.txt': 'v1' },
      });
      const v2Dir = await sandbox.createPluginSource('model-v2', {
        manifest: { name: 'model-ow', displayName: 'Model OW', version: '2.0.0' },
        files: { 'marker.txt': 'v2' },
      });
      const initialCfg = JSON.stringify({ plugins: { 'model-ow': { enabled: true } } }, null, 2);
      await sandbox.writeConfig(initialCfg);
      await mcp.initialize();
      await mcp.callTool('install_plugin', { source: v1Dir });

      const res = await mcp.callTool('install_plugin', {
        source: v2Dir,
        overwrite: true,
      });
      assert.equal(res.isError, undefined);
      assert.equal(res.structuredContent.lastInstall.overwrote, true);
      assert.equal(res.structuredContent.lastInstall.plugin.customizationUri, 'customization://model-ow');

      const marker = await fs.readFile(path.join(sandbox.globalPluginsDir, 'model-ow', 'marker.txt'), 'utf8');
      assert.equal(marker, 'v2');
      assert.equal(await sandbox.readConfigRaw(), initialCfg);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T1-F5-04: Update of workspace plugin replaces files cleanly without touching config.json', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      const srcDir = await sandbox.createPluginSource('ws-upd', {
        manifest: { name: 'ws-upd', displayName: 'WS Upd', version: '1.0.0' },
        files: { 'marker.txt': 'v1' },
      });
      await mcp.initialize();
      await mcp.callTool('app_install_plugin', {
        source: srcDir,
        scope: 'workspace',
        workspacePath: sandbox.workspaceDir,
      });

      await sandbox.createPluginSource('ws-upd', {
        targetDir: srcDir,
        manifest: { name: 'ws-upd', displayName: 'WS Upd', version: '2.0.0' },
        files: { 'marker.txt': 'v2' },
      });

      const res = await mcp.callTool('app_reinstall_plugin', {
        dir: 'ws-upd',
        scope: 'workspace',
        workspacePath: sandbox.workspaceDir,
      });
      assert.equal(res.structuredContent.ok, true, res.structuredContent.error);
      const marker = await fs.readFile(path.join(sandbox.workspacePluginsDir, 'ws-upd', 'marker.txt'), 'utf8');
      assert.equal(marker, 'v2');
      await assert.rejects(() => fs.stat(sandbox.configPath), { code: 'ENOENT' });
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  // =========================================================================
  // F6: Disabled state preservation & validation gates (4 cases)
  // =========================================================================

  test('E2E-T1-F6-01: app_reinstall_plugin on disabled plugin keeps enabled: false and config.json untouched', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      const srcDir = await sandbox.createPluginSource('stay-dis', {
        manifest: { name: 'stay-dis', displayName: 'Stay Disabled', version: '1.0.0' },
        files: { 'marker.txt': 'v1' },
      });
      const initialCfg = JSON.stringify({ plugins: { 'stay-dis': { enabled: false } } }, null, 2);
      await sandbox.writeConfig(initialCfg);
      await mcp.initialize();
      await mcp.callTool('app_install_plugin', { source: srcDir });

      await sandbox.createPluginSource('stay-dis', {
        targetDir: srcDir,
        manifest: { name: 'stay-dis', displayName: 'Stay Disabled', version: '2.0.0' },
        files: { 'marker.txt': 'v2' },
      });

      const res = await mcp.callTool('app_reinstall_plugin', { dir: 'stay-dis', scope: 'global' });
      assert.equal(res.structuredContent.ok, true);
      assert.equal(res.structuredContent.install.enabled, false);

      const p = res.structuredContent.inventory.plugins.find((x) => x.dir === 'stay-dis');
      assert.equal(p.enabled, false);
      assert.equal(await sandbox.readConfigRaw(), initialCfg);
      const marker = await fs.readFile(path.join(sandbox.globalPluginsDir, 'stay-dis', 'marker.txt'), 'utf8');
      assert.equal(marker, 'v2');
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T1-F6-02: Manifest disabled: true is respected read-only without creating config.json', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      const v1Dir = await sandbox.createPluginSource('man-dis-1', {
        manifest: {
          name: 'man-dis',
          displayName: 'Man Dis',
          version: '1.0.0',
          disabled: true,
        },
        files: { 'marker.txt': 'v1' },
      });

      await mcp.initialize();
      const res = await mcp.callTool('app_install_plugin', { source: v1Dir });
      assert.equal(res.structuredContent.ok, true);
      assert.equal(res.structuredContent.install.enabled, false);

      const plugin = res.structuredContent.inventory.plugins.find((p) => p.dir === 'man-dis');
      assert.equal(plugin.enabled, false);
      await assert.rejects(() => fs.stat(sandbox.configPath), { code: 'ENOENT' });
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T1-F6-03: Failed source fetch before deletion preserves plugin files and config.json', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      const srcDir = await sandbox.createPluginSource('miss-src', {
        manifest: { name: 'miss-src', displayName: 'Miss Src', version: '1.0.0' },
        files: { 'marker.txt': 'v1-intact' },
      });
      const initialCfg = JSON.stringify({ plugins: { 'miss-src': { enabled: true } } }, null, 2);
      await sandbox.writeConfig(initialCfg);
      await mcp.initialize();
      await mcp.callTool('app_install_plugin', { source: srcDir });

      await fs.rm(srcDir, { recursive: true, force: true });

      const res = await mcp.callTool('app_reinstall_plugin', { dir: 'miss-src', scope: 'global' });
      assert.equal(res.structuredContent.ok, false);

      const marker = await fs.readFile(path.join(sandbox.globalPluginsDir, 'miss-src', 'marker.txt'), 'utf8');
      assert.equal(marker, 'v1-intact');
      assert.equal(await sandbox.readConfigRaw(), initialCfg);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T1-F6-04: Failed candidate manifest validation during staging preserves plugin files and config.json', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      const v1Dir = await sandbox.createPluginSource('bad-cand-1', {
        manifest: { name: 'bad-cand', displayName: 'Bad Cand', version: '1.0.0' },
        files: { 'marker.txt': 'v1-intact' },
      });
      const badV2Dir = await sandbox.createPluginSource('bad-cand-2', {
        rawManifest: '{ "name": "Bad_Name", broken json',
      });
      const initialCfg = JSON.stringify({ plugins: { 'bad-cand': { enabled: true } } }, null, 2);
      await sandbox.writeConfig(initialCfg);
      await mcp.initialize();
      await mcp.callTool('app_install_plugin', { source: v1Dir });

      const res = await mcp.callTool('app_install_plugin', {
        source: badV2Dir,
        targetDirName: 'bad-cand',
        overwrite: true,
      });
      assert.equal(res.structuredContent.ok, false);

      const marker = await fs.readFile(path.join(sandbox.globalPluginsDir, 'bad-cand', 'marker.txt'), 'utf8');
      assert.equal(marker, 'v1-intact');
      assert.equal(await sandbox.readConfigRaw(), initialCfg);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });
});
