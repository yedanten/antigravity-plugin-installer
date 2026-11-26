import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { launchHeadlessBrowser } from './helpers/browser-host.mjs';
import { spawnMcpClient } from './helpers/mcp-client.mjs';
import { startMockNpmRegistry } from './helpers/mock-servers.mjs';
import { spawnLockedPluginProcess } from './helpers/process-lock.mjs';
import { createSandbox } from './helpers/sandbox.mjs';

describe('Tier 2: Boundary, Error & Edge Cases (32 cases)', () => {
  let browser;

  before(async () => {
    browser = await launchHeadlessBrowser();
  });

  after(async () => {
    if (browser) await browser.close();
  });

  // =========================================================================
  // F1: Strict Validation & Path Edge Cases (5 cases)
  // =========================================================================

  test('E2E-T2-F1-01: Root AGENTS.md triggers strict validation failure in agy.exe', async () => {
    const sandbox = await createSandbox();
    try {
      const srcDir = await sandbox.createPluginSource('misplaced-agents', {
        manifest: { name: 'misplaced-agents', version: '1.0.0' },
        rootAgentsMd: '# Misplaced root rule\n',
      });
      const res = await sandbox.runAgy(['plugin', 'validate', '--strict', '--json', srcDir]);
      assert.equal(res.code, 1);
      assert.match(res.stdout + res.stderr, /rules\/AGENTS\.md/);
    } finally {
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F1-02: Misplaced .mcp.json / hooks/hooks.json / bad name casing flagged in strict & server validation', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      const misplacedDir = await sandbox.createPluginSource('misplaced-cfg', {
        manifest: { name: 'misplaced-cfg', version: '1.0.0' },
        dotMcpJson: { mcpServers: {} },
        nestedHooks: { hooks: [] },
      });
      const agyMisplaced = await sandbox.runAgy(['plugin', 'validate', '--strict', misplacedDir]);
      assert.equal(agyMisplaced.code, 1);

      await sandbox.placeInstalledPlugin('global', 'bad-case', {
        manifest: { name: 'My_Plugin', version: '1.0.0' },
        dotMcpJson: { mcpServers: {} },
        nestedHooks: { hooks: [] },
      });

      const agyBadCase = await sandbox.runAgy([
        'plugin',
        'validate',
        '--strict',
        path.join(sandbox.globalPluginsDir, 'bad-case'),
      ]);
      assert.equal(agyBadCase.code, 1);

      await mcp.initialize();
      const listRes = await mcp.callTool('app_list_plugins', {});
      const bad = listRes.structuredContent.plugins.find((p) => p.dir === 'bad-case');
      assert.equal(bad.valid, false);
      assert.ok(bad.errors.some((e) => /kebab-case/i.test(e)));
      assert.ok(bad.warnings.some((w) => /\.mcp\.json/i.test(w)));
      assert.ok(bad.warnings.some((w) => /hooks\/hooks\.json/i.test(w)));
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F1-03: plugin.json with unknown keys triggers strict failure in agy and warning in server', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      const pDir = await sandbox.placeInstalledPlugin('global', 'unknown-key-p', {
        manifest: {
          name: 'unknown-key-p',
          version: '1.0.0',
          unknownField: 123,
        },
      });
      const agyRes = await sandbox.runAgy(['plugin', 'validate', '--strict', pDir]);
      assert.equal(agyRes.code, 1);

      await mcp.initialize();
      const listRes = await mcp.callTool('app_list_plugins', {});
      const p = listRes.structuredContent.plugins.find((x) => x.dir === 'unknown-key-p');
      assert.ok(p.warnings.some((w) => /unknownField/i.test(w)));
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F1-04: logo path traversal (../../outside.svg) rejected and ignored safely', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      await fs.writeFile(
        path.join(sandbox.globalPluginsDir, 'secret.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        'utf8',
      );
      await sandbox.placeInstalledPlugin('global', 'logo-escape', {
        manifest: {
          name: 'logo-escape',
          version: '1.0.0',
          logo: '../secret.svg',
        },
      });

      await mcp.initialize();
      const res = await mcp.callTool('app_list_plugins', {});
      const p = res.structuredContent.plugins.find((x) => x.dir === 'logo-escape');
      assert.equal(p.logoDataUri, null);
      assert.equal(p.valid, false);
      assert.ok(p.errors.some((e) => /logo.*escape/i.test(e)));
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F1-05: Server operates cleanly when PATH lacks ~/.gemini/bin', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({
      dataDir: sandbox.dataDir,
      env: sandbox.env({ PATH: path.dirname(process.execPath) }),
    });
    try {
      await sandbox.placeInstalledPlugin('global', 'no-path-p');
      const init = await mcp.initialize();
      assert.equal(init.serverInfo.name, 'plugin-installer');

      const listRes = await mcp.callTool('app_list_plugins', {});
      const plugin = listRes.structuredContent.plugins.find((p) => p.dir === 'no-path-p');
      assert.ok(plugin);
      assert.equal(plugin.enabled, true);
      assert.equal(plugin.customizationUri, 'customization://no-path-p');
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  // =========================================================================
  // F2: JSONC / Config Edge Cases & Precedence (5 cases)
  // =========================================================================

  test('E2E-T2-F2-01: MCP server entry with BOTH url and command rejected as invalid', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      await sandbox.placeInstalledPlugin('global', 'dual-transport', {
        manifest: { name: 'dual-transport', version: '1.0.0' },
        mcpConfig: {
          mcpServers: {
            bad: { command: 'node', url: 'https://example.com/mcp' },
          },
        },
      });

      await mcp.initialize();
      const res = await mcp.callTool('app_list_plugins', {});
      const p = res.structuredContent.plugins.find((x) => x.dir === 'dual-transport');
      assert.equal(p.valid, false);
      assert.ok(p.errors.some((e) => /cannot specify both/i.test(e)));
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F2-02: config.json missing, 0-byte, and whitespace-only handled gracefully', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      await sandbox.placeInstalledPlugin('global', 'p-default-on');
      await sandbox.placeInstalledPlugin('global', 'p-manifest-off', {
        manifest: { name: 'p-manifest-off', version: '1.0.0', disabled: true },
      });

      await mcp.initialize();
      const res1 = await mcp.callTool('app_list_plugins', {});
      assert.equal(res1.structuredContent.plugins.find((p) => p.dir === 'p-default-on').enabled, true);
      assert.equal(res1.structuredContent.plugins.find((p) => p.dir === 'p-manifest-off').enabled, false);

      await sandbox.writeConfig('');
      const res2 = await mcp.callTool('app_list_plugins', {});
      assert.equal(res2.structuredContent.plugins.find((p) => p.dir === 'p-default-on').enabled, true);

      await sandbox.writeConfig('   \r\n\t  ');
      const res3 = await mcp.callTool('app_list_plugins', {});
      assert.equal(res3.structuredContent.plugins.find((p) => p.dir === 'p-default-on').enabled, true);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F2-03: Corrupted JSON in config.json stays up on list without touching config.json', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      await sandbox.placeInstalledPlugin('global', 'p1');
      const broken = '{ "plugins": { "p1": { broken json';
      await sandbox.writeConfig(broken);

      await mcp.initialize();
      const listRes = await mcp.callTool('app_list_plugins', {});
      assert.equal(listRes.structuredContent.ok, true);
      assert.equal(listRes.structuredContent.plugins.length, 1);
      assert.equal(await sandbox.readConfigRaw(), broken);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F2-04: BOM + comments in .antigravity-plugin/plugin.json and mcp_config.json parsed cleanly', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      await sandbox.placeInstalledPlugin('global', 'bom-both', {
        manifestSubdir: '.antigravity-plugin',
        bom: true,
        jsoncComments: true,
        manifest: { name: 'bom-both', displayName: 'BOM Both', version: '1.0.0' },
        mcpConfig: { mcpServers: { s1: { command: 'node', args: ['s1.js'] } } },
        mcpConfigBom: true,
        mcpConfigComments: true,
      });

      await mcp.initialize();
      const res = await mcp.callTool('app_list_plugins', {});
      const p = res.structuredContent.plugins.find((x) => x.dir === 'bom-both');
      assert.equal(p.valid, true);
      assert.deepEqual(p.components.mcpServers, ['s1']);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F2-05: ANTIGRAVITY_APP_DATA_DIR overrides default USERPROFILE/.gemini/antigravity builtin dir', async () => {
    const sandbox = await createSandbox();
    const customAppData = path.join(sandbox.root, 'custom-appdata');
    const mcp = spawnMcpClient({
      dataDir: sandbox.dataDir,
      env: sandbox.env(
        { ANTIGRAVITY_APP_DATA_DIR: customAppData },
        { omitBuiltinPluginsDir: true },
      ),
    });
    try {
      // Put different plugin in default USERPROFILE/.gemini/antigravity/builtin/plugins
      await sandbox.placeInstalledPlugin('builtin', 'default-only');
      // Put expected plugin in ANTIGRAVITY_APP_DATA_DIR/builtin/plugins
      const customBuiltinDir = path.join(customAppData, 'builtin', 'plugins', 'appdata-builtin');
      await fs.mkdir(customBuiltinDir, { recursive: true });
      await fs.writeFile(
        path.join(customBuiltinDir, 'plugin.json'),
        JSON.stringify({ name: 'appdata-builtin', displayName: 'AppData Builtin', version: '1.0.0' }),
        'utf8',
      );

      await mcp.initialize();
      const res = await mcp.callTool('app_list_plugins', {});
      const names = res.structuredContent.plugins.map((p) => p.dir);
      assert.ok(names.includes('appdata-builtin'));
      assert.ok(!names.includes('default-only'));
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  // =========================================================================
  // F3: Config.json Non-Mutation Guarantee & Removed Direct Toggle Tool (2 cases)
  // =========================================================================

  test('E2E-T2-F3-01: Removed app_set_plugin_enabled tool is rejected by MCP server without mutating config.json', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      await sandbox.placeInstalledPlugin('global', 'safe');
      const initialCfg = JSON.stringify({ plugins: { safe: { enabled: true } } }, null, 2);
      await sandbox.writeConfig(initialCfg);
      await mcp.initialize();

      await assert.rejects(
        () =>
          mcp.callTool('app_set_plugin_enabled', {
            dir: 'safe',
            scope: 'global',
            enabled: false,
          }),
        /Unknown tool|not found/i,
      );

      assert.equal(await sandbox.readConfigRaw(), initialCfg);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F3-02: Install, list, and uninstall never create or mutate config.json', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      const srcDir = await sandbox.createPluginSource('no-cfg-touch', {
        manifest: { name: 'no-cfg-touch', version: '1.0.0' },
      });
      await mcp.initialize();

      const inst = await mcp.callTool('app_install_plugin', { source: srcDir });
      assert.equal(inst.structuredContent.ok, true);
      const list = await mcp.callTool('app_list_plugins', {});
      assert.equal(list.structuredContent.plugins.length, 1);
      const uninst = await mcp.callTool('app_uninstall_plugin', { dir: 'no-cfg-touch', scope: 'global' });
      assert.equal(uninst.structuredContent.ok, true);

      await assert.rejects(() => fs.stat(sandbox.configPath), { code: 'ENOENT' });
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  // =========================================================================
  // F4: UI Filter, Built-in Native Guide & Narrow Viewport Edge Cases (3 cases)
  // =========================================================================

  test('E2E-T2-F4-01: Filter tabs and search keep read-only status badges accurate', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let session;
    try {
      await sandbox.placeInstalledPlugin('global', 'alpha-global', {
        manifest: { name: 'alpha-global', displayName: 'Alpha Global', version: '1.0.0' },
      });
      await sandbox.placeInstalledPlugin('workspace', 'beta-ws', {
        manifest: { name: 'beta-ws', displayName: 'Beta Workspace', version: '1.0.0' },
      });
      await sandbox.placeInstalledPlugin('builtin', 'gamma-bi', {
        manifest: { name: 'gamma-bi', displayName: 'Gamma Builtin', version: '1.0.0' },
      });
      await sandbox.writeConfig({ plugins: { 'alpha-global': { enabled: false } } });

      await mcp.initialize();
      session = await browser.openAppSession({ mcpClient: mcp });

      // Load workspace path via UI workspace bar
      await session.click('[data-action="toggle-workspace-bar"]');
      await session.setInputValue('#workspace-scan-input', sandbox.workspaceDir);
      await session.click('[data-action="apply-workspace"]');
      await session.waitForSelector('.plugin-card[data-plugin-id="workspace:beta-ws"]');

      // Filter to Installed (user) and search "Alpha"
      await session.click('[data-action="set-filter"][data-value="user"]');
      await session.setInputValue('#plugin-search-input', 'Alpha');

      const alphaCard = await session.getCardInfo('global:alpha-global');
      assert.equal(alphaCard.exists, true);
      assert.equal(alphaCard.toggleExists, false);
      assert.ok(alphaCard.badges.some((b) => /Disabled|已禁用/i.test(b)));
      const betaCard = await session.getCardInfo('workspace:beta-ws');
      assert.equal(betaCard.exists, false);

      // Switch to Built-in filter and clear search
      await session.setInputValue('#plugin-search-input', '');
      await session.click('[data-action="set-filter"][data-value="builtin"]');
      const gammaCard = await session.getCardInfo('builtin:gamma-bi');
      assert.equal(gammaCard.exists, true);
      assert.ok(gammaCard.badges.some((b) => /Enabled|已启用/i.test(b)));
    } finally {
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F4-02: Built-in plugin card shows native management guide without uninstall button', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let session;
    try {
      await sandbox.placeInstalledPlugin('builtin', 'bi-guide', {
        manifest: { name: 'bi-guide', displayName: 'BI Guide', version: '1.0.0' },
      });
      await mcp.initialize();
      session = await browser.openAppSession({ mcpClient: mcp });

      const beforeCard = await session.getCardInfo('builtin:bi-guide');
      assert.equal(beforeCard.toggleExists, false);
      assert.equal(beforeCard.manageBtnExists, true);

      await session.click('.plugin-card[data-plugin-id="builtin:bi-guide"] [data-action="toggle-manage-native"]');
      await session.waitForSelector('.plugin-card[data-plugin-id="builtin:bi-guide"] .native-guide-box');

      const afterCard = await session.getCardInfo('builtin:bi-guide');
      assert.ok(afterCard.nativeGuideText.includes('customization://bi-guide'));
    } finally {
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F4-03: Dark theme and narrow aux-pane width (420px) render card and native guide cleanly without clipping', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let session;
    try {
      await sandbox.placeInstalledPlugin('global', 'narrow-p', {
        manifest: { name: 'narrow-p', displayName: 'Very Long Narrow Aux Pane Plugin Name', version: '1.0.0' },
      });
      await mcp.initialize();
      session = await browser.openAppSession({
        mcpClient: mcp,
        hostCapabilities: { serverTools: {}, openLinks: {}, message: {} },
        viewport: { width: 420, height: 700 },
      });

      await session.setHostContext({ theme: 'dark', locale: 'en-US' });
      const themeAttr = await session.evalInApp((doc) => doc.documentElement.getAttribute('data-theme'));
      assert.equal(themeAttr, 'dark');

      await session.click('.plugin-card[data-plugin-id="global:narrow-p"] [data-action="toggle-manage-native"]');
      await session.waitForSelector('.plugin-card[data-plugin-id="global:narrow-p"] .native-guide-box');

      const card = await session.getCardInfo('global:narrow-p');
      assert.equal(card.toggleExists, false);
      assert.equal(card.nativeGuideExists, true);
      assert.equal(card.sendChatBtnExists, true);
      assert.ok(card.manageBtnRect && card.manageBtnRect.right <= card.viewportWidth + 1);
      assert.ok(card.scrollWidth <= card.viewportWidth + 1, `Horizontal scroll overflow: ${card.scrollWidth} > ${card.viewportWidth}`);
    } finally {
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  // =========================================================================
  // F5: Locking, Retry, Symlink & Update Boundaries (4 cases)
  // =========================================================================

  test('E2E-T2-F5-01: Persistent unreleasing lock fails cleanly within bounded retries with customizationUri and no config.json write', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let lock;
    try {
      const srcDir = await sandbox.createPluginSource('stuck-p', {
        manifest: { name: 'stuck-p', displayName: 'Stuck P', version: '1.0.0' },
      });
      await mcp.initialize();
      await mcp.callTool('app_install_plugin', { source: srcDir });

      const installedDir = path.join(sandbox.globalPluginsDir, 'stuck-p');
      lock = await spawnLockedPluginProcess({
        pluginDir: installedDir,
        releaseOnDisable: false,
      });
      sandbox.trackChild(lock.child);

      await sandbox.createPluginSource('stuck-p', {
        targetDir: srcDir,
        manifest: { name: 'stuck-p', displayName: 'Stuck P', version: '2.0.0' },
      });

      const res = await mcp.callTool(
        'app_reinstall_plugin',
        { dir: 'stuck-p', scope: 'global' },
        { timeoutMs: 20000 },
      );
      assert.equal(res.structuredContent.ok, false);
      assert.equal(res.structuredContent.locked, true);
      assert.equal(res.structuredContent.customizationUri, 'customization://stuck-p');
      assert.match(res.structuredContent.error, /locked|EBUSY|EPERM/i);
      assert.equal(lock.isAlive(), true);
      await assert.rejects(() => fs.stat(sandbox.configPath), { code: 'ENOENT' });
    } finally {
      if (lock) await lock.forceKill();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F5-02: Symlink/junction local plugin (mode: link) updates cleanly without deleting source or touching config.json', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      const srcDir = await sandbox.createPluginSource('link-p', {
        manifest: { name: 'link-p', displayName: 'Link P', version: '1.0.0' },
        files: { 'src-file.txt': 'keep-me' },
      });
      await mcp.initialize();
      const installRes = await mcp.callTool('app_install_plugin', {
        source: srcDir,
        mode: 'link',
      });
      assert.equal(installRes.structuredContent.ok, true);
      assert.equal(installRes.structuredContent.install.plugin.mode, 'link');

      await sandbox.createPluginSource('link-p', {
        targetDir: srcDir,
        manifest: { name: 'link-p', displayName: 'Link P', version: '2.0.0' },
        files: { 'src-file.txt': 'keep-me-v2' },
      });

      const reinstallRes = await mcp.callTool('app_reinstall_plugin', {
        dir: 'link-p',
        scope: 'global',
      });
      assert.equal(reinstallRes.structuredContent.ok, true);

      const srcContent = await fs.readFile(path.join(srcDir, 'src-file.txt'), 'utf8');
      assert.equal(srcContent, 'keep-me-v2');
      const lstat = await fs.lstat(path.join(sandbox.globalPluginsDir, 'link-p'));
      assert.equal(lstat.isSymbolicLink(), true);
      await assert.rejects(() => fs.stat(sandbox.configPath), { code: 'ENOENT' });
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F5-03: app_reinstall_plugin on plugin missing installMeta returns error without touching config.json', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      await sandbox.placeInstalledPlugin('global', 'manual-p');
      const initialCfg = JSON.stringify({ plugins: { 'manual-p': { enabled: true } } }, null, 2);
      await sandbox.writeConfig(initialCfg);
      await mcp.initialize();

      const res = await mcp.callTool('app_reinstall_plugin', { dir: 'manual-p', scope: 'global' });
      assert.equal(res.structuredContent.ok, false);
      assert.match(res.structuredContent.error, /No saved source metadata/i);
      assert.equal(await sandbox.readConfigRaw(), initialCfg);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F5-04: app_install_plugin without overwrite on existing plugin returns PLUGIN_EXISTS without touching files or config.json', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      const srcDir = await sandbox.createPluginSource('no-ow', {
        manifest: { name: 'no-ow', displayName: 'No OW', version: '1.0.0' },
      });
      const initialCfg = JSON.stringify({ plugins: { 'no-ow': { enabled: true } } }, null, 2);
      await sandbox.writeConfig(initialCfg);
      await mcp.initialize();
      await mcp.callTool('app_install_plugin', { source: srcDir });

      const res = await mcp.callTool('app_install_plugin', {
        source: srcDir,
        overwrite: false,
      });
      assert.equal(res.structuredContent.ok, false);
      assert.equal(res.structuredContent.code, 'PLUGIN_EXISTS');
      assert.equal(await sandbox.readConfigRaw(), initialCfg);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  // =========================================================================
  // F6: Self-Update Guard, Rollback & State Preservation (5 cases)
  // =========================================================================

  test('E2E-T2-F6-01: Self-update guard blocks overwriting live PLUGIN_ROOT (plugin-installer)', async () => {
    const sandbox = await createSandbox();
    const selfCopy = await sandbox.stageSandboxedSelfCopy();
    const mcp = spawnMcpClient({
      serverEntry: selfCopy.serverEntry,
      dataDir: sandbox.dataDir,
      env: sandbox.env(),
    });
    try {
      const altSource = await sandbox.createPluginSource('fake-installer', {
        manifest: { name: 'plugin-installer', displayName: 'Fake Installer', version: '9.9.9' },
        files: { 'marker.txt': 'evil' },
      });
      await mcp.initialize();

      const owRes = await mcp.callTool('app_install_plugin', {
        source: altSource,
        targetDirName: 'plugin-installer',
        overwrite: true,
      });
      assert.equal(owRes.structuredContent.ok, false);
      assert.equal(owRes.structuredContent.code, 'SELF_UPDATE_BLOCKED');

      const pkgJson = JSON.parse(
        await fs.readFile(path.join(selfCopy.pluginDir, 'plugin.json'), 'utf8'),
      );
      assert.notEqual(pkgJson.version, '9.9.9');
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F6-02: Unreachable/failing HTTP 500 mock npm registry during app_reinstall_plugin preserves existing plugin & config.json', async () => {
    const sandbox = await createSandbox();
    const registry = await startMockNpmRegistry({
      packages: {
        'e2e-npm-plugin': {
          latest: '1.0.0',
          versions: {
            '1.0.0': [
              {
                name: 'package/plugin.json',
                content: JSON.stringify({
                  name: 'e2e-npm-plugin',
                  displayName: 'E2E npm Plugin',
                  version: '1.0.0',
                }),
              },
              { name: 'package/marker.txt', content: 'npm-v1' },
            ],
          },
        },
      },
    });
    sandbox.onCleanup(() => registry.close());

    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      const initialCfg = JSON.stringify({ plugins: { 'e2e-npm-plugin': { enabled: true } } }, null, 2);
      await sandbox.writeConfig(initialCfg);
      await mcp.initialize();
      const installRes = await mcp.callTool('app_install_plugin', {
        source: 'e2e-npm-plugin',
        sourceType: 'npm',
        registry: registry.url,
      });
      assert.equal(installRes.structuredContent.ok, true, installRes.structuredContent.error);

      registry.setFailStatus(500);
      const reinstallRes = await mcp.callTool('app_reinstall_plugin', {
        dir: 'e2e-npm-plugin',
        scope: 'global',
      });
      assert.equal(reinstallRes.structuredContent.ok, false);
      assert.match(reinstallRes.structuredContent.error, /HTTP 500/i);

      const marker = await fs.readFile(
        path.join(sandbox.globalPluginsDir, 'e2e-npm-plugin', 'marker.txt'),
        'utf8',
      );
      assert.equal(marker, 'npm-v1');
      assert.equal(await sandbox.readConfigRaw(), initialCfg);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F6-03: Candidate missing plugin.json during overwrite fails without touching files or config.json', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      const v1Dir = await sandbox.createPluginSource('no-manifest-1', {
        manifest: { name: 'no-manifest', version: '1.0.0' },
        files: { 'marker.txt': 'v1' },
      });
      const v2Missing = await sandbox.createPluginSource('no-manifest-2', {
        manifest: null,
        files: { 'readme.txt': 'missing plugin.json' },
      });
      const initialCfg = JSON.stringify({ plugins: { 'no-manifest': { enabled: true } } }, null, 2);
      await sandbox.writeConfig(initialCfg);

      await mcp.initialize();
      await mcp.callTool('app_install_plugin', { source: v1Dir });

      const res = await mcp.callTool('app_install_plugin', {
        source: v2Missing,
        targetDirName: 'no-manifest',
        overwrite: true,
      });
      assert.equal(res.structuredContent.ok, false);
      assert.match(res.structuredContent.error, /Missing plugin\.json/i);
      assert.equal(await sandbox.readConfigRaw(), initialCfg);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F6-04: Uninstalling a disabled plugin preserves config.json byte-for-byte', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      await sandbox.placeInstalledPlugin('global', 'p1');
      await sandbox.placeInstalledPlugin('global', 'p2');
      const initialCfg = JSON.stringify(
        {
          plugins: {
            p1: { enabled: false },
            p2: { enabled: true },
          },
        },
        null,
        2,
      );
      await sandbox.writeConfig(initialCfg);
      await mcp.initialize();

      const res = await mcp.callTool('app_uninstall_plugin', { dir: 'p1', scope: 'global' });
      assert.equal(res.structuredContent.ok, true);
      assert.equal(await sandbox.readConfigRaw(), initialCfg);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F6-05: Update changing manifest.version while keeping dir preserves disabled config.json state and updates installMeta', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      const srcDir = await sandbox.createPluginSource('ver-bump', {
        manifest: { name: 'ver-bump', displayName: 'Ver Bump', version: '1.0.0' },
      });
      const initialCfg = JSON.stringify({ plugins: { 'ver-bump': { enabled: false } } }, null, 2);
      await sandbox.writeConfig(initialCfg);
      await mcp.initialize();
      await mcp.callTool('app_install_plugin', { source: srcDir });

      await sandbox.createPluginSource('ver-bump', {
        targetDir: srcDir,
        manifest: { name: 'ver-bump', displayName: 'Ver Bump', version: '2.0.0' },
      });

      const res = await mcp.callTool('app_reinstall_plugin', { dir: 'ver-bump', scope: 'global' });
      assert.equal(res.structuredContent.ok, true);
      const p = res.structuredContent.inventory.plugins.find((x) => x.dir === 'ver-bump');
      assert.equal(p.version, '2.0.0');
      assert.equal(p.enabled, false);
      assert.equal(p.installMeta.version, '2.0.0');
      assert.equal(await sandbox.readConfigRaw(), initialCfg);

      const reg = await sandbox.readInstallRegistry();
      assert.equal(reg.entries['global:ver-bump'].version, '2.0.0');
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });
});
