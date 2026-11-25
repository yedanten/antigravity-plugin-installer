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

      const toggle = await mcp.callTool('app_set_plugin_enabled', {
        dir: 'no-path-p',
        scope: 'global',
        enabled: false,
      });
      assert.equal(toggle.structuredContent.ok, true);
      const cfg = await sandbox.readConfig();
      assert.equal(cfg.plugins['no-path-p'].enabled, false);
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

  test('E2E-T2-F2-03: Corrupted JSON in config.json stays up on list and refuses destructive overwrite on toggle', async () => {
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

      const toggleRes = await mcp.callTool('app_set_plugin_enabled', {
        dir: 'p1',
        scope: 'global',
        enabled: false,
      });
      assert.equal(toggleRes.structuredContent.ok, false);
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
  // F3: app_set_plugin_enabled Safety, Validation & Concurrency (6 cases)
  // =========================================================================

  test('E2E-T2-F3-01: app_set_plugin_enabled rejects path traversal dir values', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      await sandbox.writeConfig({ plugins: { safe: { enabled: true } } });
      await mcp.initialize();

      for (const badDir of ['../evil', 'a/b', 'a\\b', '.', '..', '']) {
        const res = await mcp.callTool('app_set_plugin_enabled', {
          dir: badDir,
          enabled: false,
        });
        assert.equal(res.structuredContent.ok, false, `Expected failure for "${badDir}"`);
      }

      const cfg = await sandbox.readConfig();
      assert.deepEqual(cfg, { plugins: { safe: { enabled: true } } });
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F3-02: app_set_plugin_enabled rejects non-boolean enabled and missing dir', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      await sandbox.placeInstalledPlugin('global', 'p1');
      await mcp.initialize();

      const badBool = await mcp.callTool('app_set_plugin_enabled', {
        dir: 'p1',
        enabled: 'false',
      });
      assert.equal(badBool.structuredContent.ok, false);

      const missingDir = await mcp.callTool('app_set_plugin_enabled', {
        enabled: false,
      });
      assert.equal(missingDir.structuredContent.ok, false);

      await assert.rejects(() => fs.stat(sandbox.configPath), { code: 'ENOENT' });
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F3-03: Self-disable guard blocks disabling live plugin-installer (PLUGIN_ROOT)', async () => {
    const sandbox = await createSandbox();
    const selfCopy = await sandbox.stageSandboxedSelfCopy();
    const mcp = spawnMcpClient({
      serverEntry: selfCopy.serverEntry,
      dataDir: sandbox.dataDir,
      env: sandbox.env(),
    });
    try {
      await mcp.initialize();
      const res = await mcp.callTool('app_set_plugin_enabled', {
        dir: 'plugin-installer',
        scope: 'global',
        enabled: false,
      });
      assert.equal(res.structuredContent.ok, false);
      assert.equal(res.structuredContent.code, 'SELF_DISABLE_BLOCKED');

      const cfg = await sandbox.readConfig();
      assert.equal(cfg.plugins['plugin-installer'].enabled, true);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F3-04: Concurrent app_set_plugin_enabled calls serialize without losing writes', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      await sandbox.placeInstalledPlugin('global', 'p1');
      await sandbox.placeInstalledPlugin('global', 'p2');
      await sandbox.placeInstalledPlugin('global', 'p3');
      await sandbox.writeConfig({ plugins: { p2: { enabled: false } } });
      await mcp.initialize();

      const results = await Promise.all([
        mcp.callTool('app_set_plugin_enabled', { dir: 'p1', scope: 'global', enabled: false }),
        mcp.callTool('app_set_plugin_enabled', { dir: 'p2', scope: 'global', enabled: true }),
        mcp.callTool('app_set_plugin_enabled', { dir: 'p3', scope: 'global', enabled: false }),
      ]);
      for (const r of results) {
        assert.equal(r.structuredContent.ok, true);
      }

      const cfg = await sandbox.readConfig();
      assert.equal(cfg.plugins.p1.enabled, false);
      assert.equal(cfg.plugins.p2.enabled, true);
      assert.equal(cfg.plugins.p3.enabled, false);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F3-05: app_set_plugin_enabled creates config.json and parent dirs when initially absent', async () => {
    const sandbox = await createSandbox();
    const nestedCfg = path.join(sandbox.root, 'fresh', 'nested', 'config.json');
    const mcp = spawnMcpClient({
      dataDir: sandbox.dataDir,
      env: sandbox.env({ ANTIGRAVITY_CONFIG_PATH: nestedCfg }),
    });
    try {
      await sandbox.placeInstalledPlugin('global', 'p1');
      await mcp.initialize();

      const res = await mcp.callTool('app_set_plugin_enabled', {
        dir: 'p1',
        scope: 'global',
        enabled: false,
      });
      assert.equal(res.structuredContent.ok, true);

      const cfg = await sandbox.readConfig(nestedCfg);
      assert.equal(cfg.plugins.p1.enabled, false);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F3-06: app_set_plugin_enabled for nonexistent plugin dir returns clear error without mutating config.json', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      await sandbox.writeConfig({ plugins: { existing: { enabled: true } } });
      await mcp.initialize();

      const res = await mcp.callTool('app_set_plugin_enabled', {
        dir: 'does-not-exist',
        scope: 'global',
        enabled: false,
      });
      assert.equal(res.structuredContent.ok, false);
      assert.match(res.structuredContent.error, /not found/i);

      const cfg = await sandbox.readConfig();
      assert.deepEqual(cfg, { plugins: { existing: { enabled: true } } });
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  // =========================================================================
  // F4: UI Toggle Edge Cases, Filters, Busy State & Viewport (5 cases)
  // =========================================================================

  test('E2E-T2-F4-01: Toggle control enters disabled/busy state while in-flight and prevents double-submit', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let session;
    try {
      await sandbox.placeInstalledPlugin('global', 'slow-p', {
        manifest: { name: 'slow-p', displayName: 'Slow P', version: '1.0.0' },
      });
      await mcp.initialize();

      session = await browser.openAppSession({
        mcpClient: mcp,
        toolDelayMs: 900,
        toolDelayFor: 'app_set_plugin_enabled',
      });

      await session.clickCardToggle('global:slow-p');
      // Immediately verify the toggle is disabled while in-flight and try clicking again
      const midState = await session.evalInApp((doc) => {
        const card = doc.querySelector('.plugin-card[data-plugin-id="global:slow-p"]');
        const sw = card?.querySelector('[role="switch"], [aria-checked]');
        const disabledWhileBusy = Boolean(sw?.disabled || sw?.getAttribute('aria-disabled') === 'true');
        sw?.click();
        return { disabledWhileBusy };
      });
      assert.equal(midState.disabledWhileBusy, true);

      await session.waitFor(
        (doc) => {
          const card = doc.querySelector('.plugin-card[data-plugin-id="global:slow-p"]');
          const sw = card?.querySelector('[role="switch"], [aria-checked]');
          return sw?.getAttribute('aria-checked') === 'false' && !sw.disabled;
        },
        [],
        { label: 'slow-p toggle settled to false' },
      );

      const calls = await session.getToolCalls();
      const setCalls = calls.filter((c) => c.name === 'app_set_plugin_enabled');
      assert.equal(setCalls.length, 1);
    } finally {
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F4-02: UI displays error toast and keeps actual state when app_set_plugin_enabled fails', async () => {
    const sandbox = await createSandbox();
    const selfCopy = await sandbox.stageSandboxedSelfCopy();
    const mcp = spawnMcpClient({
      serverEntry: selfCopy.serverEntry,
      dataDir: sandbox.dataDir,
      env: sandbox.env(),
    });
    let session;
    try {
      await mcp.initialize();
      session = await browser.openAppSession({ mcpClient: mcp });

      await session.clickCardToggle('global:plugin-installer');
      await session.waitForSelector('.toast.error');

      const card = await session.getCardInfo('global:plugin-installer');
      assert.equal(card.ariaChecked, 'true');
      assert.ok(card.badges.some((b) => /Enabled|已启用/i.test(b)));
    } finally {
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F4-03: Filter tabs and search keep toggle state accurate', async () => {
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

      await mcp.initialize();
      session = await browser.openAppSession({ mcpClient: mcp });

      // Load workspace path via UI workspace bar
      await session.click('[data-action="toggle-workspace-bar"]');
      await session.setInputValue('#workspace-scan-input', sandbox.workspaceDir);
      await session.click('[data-action="apply-workspace"]');
      await session.waitForSelector('.plugin-card[data-plugin-id="workspace:beta-ws"]');

      // Toggle alpha-global disabled
      await session.clickCardToggle('global:alpha-global');
      await session.waitForToggleState('global:alpha-global', false);

      // Filter to Installed (user) and search "Alpha"
      await session.click('[data-action="set-filter"][data-value="user"]');
      await session.setInputValue('#plugin-search-input', 'Alpha');

      const alphaCard = await session.getCardInfo('global:alpha-global');
      assert.equal(alphaCard.exists, true);
      assert.equal(alphaCard.ariaChecked, 'false');
      assert.ok(alphaCard.badges.some((b) => /Disabled|已禁用/i.test(b)));
      const betaCard = await session.getCardInfo('workspace:beta-ws');
      assert.equal(betaCard.exists, false);

      // Switch to Built-in filter and clear search
      await session.setInputValue('#plugin-search-input', '');
      await session.click('[data-action="set-filter"][data-value="builtin"]');
      const gammaCard = await session.getCardInfo('builtin:gamma-bi');
      assert.equal(gammaCard.exists, true);
      assert.equal(gammaCard.ariaChecked, 'true');
    } finally {
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F4-04: Built-in plugin card toggle works consistently in headless Edge', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let session;
    try {
      await sandbox.placeInstalledPlugin('builtin', 'bi-toggle', {
        manifest: { name: 'bi-toggle', displayName: 'BI Toggle', version: '1.0.0' },
      });
      await mcp.initialize();
      session = await browser.openAppSession({ mcpClient: mcp });

      const beforeCard = await session.getCardInfo('builtin:bi-toggle');
      assert.equal(beforeCard.toggleExists, true);
      assert.equal(beforeCard.ariaChecked, 'true');

      await session.clickCardToggle('builtin:bi-toggle');
      await session.waitForToggleState('builtin:bi-toggle', false);

      const cfg = await sandbox.readConfig();
      assert.equal(cfg.plugins['bi-toggle'].enabled, false);
    } finally {
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F4-05: Dark theme and narrow aux-pane width (420px) render toggle cleanly without clipping', async () => {
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
        viewport: { width: 420, height: 700 },
      });

      await session.setHostContext({ theme: 'dark', locale: 'en-US' });
      const themeAttr = await session.evalInApp((doc) => doc.documentElement.getAttribute('data-theme'));
      assert.equal(themeAttr, 'dark');

      const card = await session.getCardInfo('global:narrow-p');
      assert.equal(card.toggleExists, true);
      assert.ok(card.toggleRect && card.toggleRect.width > 0 && card.toggleRect.height > 0);
      assert.ok(card.toggleRect.right <= card.viewportWidth + 1, `Toggle overflows right: ${JSON.stringify(card)}`);
      assert.ok(card.scrollWidth <= card.viewportWidth + 1, `Horizontal scroll overflow: ${card.scrollWidth} > ${card.viewportWidth}`);

      await session.clickCardToggle('global:narrow-p');
      await session.waitForToggleState('global:narrow-p', false);
    } finally {
      if (session) await session.close();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  // =========================================================================
  // F5: Locking, Retry, Symlink & Update Boundaries (5 cases)
  // =========================================================================

  test('E2E-T2-F5-01: Persistent unreleasing lock fails cleanly within bounded retries without hanging', async () => {
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
      assert.match(res.structuredContent.error, /locked|EBUSY|EPERM/i);
      assert.equal(lock.isAlive(), true);
    } finally {
      if (lock) await lock.forceKill();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F5-02: Transient EBUSY requiring multiple retries succeeds and restores enabled: true', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let lock;
    try {
      const srcDir = await sandbox.createPluginSource('retry-p', {
        manifest: { name: 'retry-p', displayName: 'Retry P', version: '1.0.0' },
        files: { 'marker.txt': 'v1' },
      });
      await mcp.initialize();
      await mcp.callTool('app_install_plugin', { source: srcDir });

      const installedDir = path.join(sandbox.globalPluginsDir, 'retry-p');
      lock = await spawnLockedPluginProcess({
        pluginDir: installedDir,
        configPath: sandbox.configPath,
        dirName: 'retry-p',
        releaseOnDisable: true,
        releaseDelayMs: 750, // Longer than 400ms settle so removeExistingWithRetry hits EBUSY and retries
      });
      sandbox.trackChild(lock.child);

      await sandbox.createPluginSource('retry-p', {
        targetDir: srcDir,
        manifest: { name: 'retry-p', displayName: 'Retry P', version: '2.0.0' },
        files: { 'marker.txt': 'v2' },
      });

      const res = await mcp.callTool('app_reinstall_plugin', { dir: 'retry-p', scope: 'global' });
      assert.equal(res.structuredContent.ok, true, res.structuredContent.error);
      await lock.waitForExit(5000);
      assert.equal(lock.wasReleasedByConfigDisable(), true);

      const marker = await fs.readFile(path.join(installedDir, 'marker.txt'), 'utf8');
      assert.equal(marker, 'v2');
      const cfg = await sandbox.readConfig();
      assert.equal(cfg.plugins['retry-p'].enabled, true);
    } finally {
      if (lock) await lock.forceKill();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F5-03: Symlink/junction local plugin (mode: link) updates cleanly when enabled without deleting source', async () => {
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
      assert.equal(reinstallRes.structuredContent.install.wasEnabled, true);
      assert.equal(reinstallRes.structuredContent.install.restoredEnabled, true);

      const srcContent = await fs.readFile(path.join(srcDir, 'src-file.txt'), 'utf8');
      assert.equal(srcContent, 'keep-me-v2');
      const lstat = await fs.lstat(path.join(sandbox.globalPluginsDir, 'link-p'));
      assert.equal(lstat.isSymbolicLink(), true);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F5-04: app_reinstall_plugin on plugin missing installMeta returns error without changing enabled', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      await sandbox.placeInstalledPlugin('global', 'manual-p');
      await sandbox.writeConfig({ plugins: { 'manual-p': { enabled: true } } });
      await mcp.initialize();

      const res = await mcp.callTool('app_reinstall_plugin', { dir: 'manual-p', scope: 'global' });
      assert.equal(res.structuredContent.ok, false);
      assert.match(res.structuredContent.error, /No saved source metadata/i);

      const cfg = await sandbox.readConfig();
      assert.equal(cfg.plugins['manual-p'].enabled, true);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F5-05: app_install_plugin without overwrite on existing enabled locked plugin returns PLUGIN_EXISTS without disabling', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let lock;
    try {
      const srcDir = await sandbox.createPluginSource('no-ow', {
        manifest: { name: 'no-ow', displayName: 'No OW', version: '1.0.0' },
      });
      await mcp.initialize();
      await mcp.callTool('app_install_plugin', { source: srcDir });
      await mcp.callTool('app_set_plugin_enabled', { dir: 'no-ow', scope: 'global', enabled: true });

      const installedDir = path.join(sandbox.globalPluginsDir, 'no-ow');
      lock = await spawnLockedPluginProcess({
        pluginDir: installedDir,
        configPath: sandbox.configPath,
        dirName: 'no-ow',
        releaseOnDisable: true,
        releaseDelayMs: 50,
      });
      sandbox.trackChild(lock.child);

      const res = await mcp.callTool('app_install_plugin', {
        source: srcDir,
        overwrite: false,
      });
      assert.equal(res.structuredContent.ok, false);
      assert.equal(res.structuredContent.code, 'PLUGIN_EXISTS');
      assert.equal(lock.wasReleasedByConfigDisable(), false);
      assert.equal(lock.isAlive(), true);

      const cfg = await sandbox.readConfig();
      assert.equal(cfg.plugins['no-ow'].enabled, true);
    } finally {
      if (lock) await lock.forceKill();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  // =========================================================================
  // F6: Self-Update Guard, Rollback & State Preservation (6 cases)
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
      const cfg = await sandbox.readConfig();
      assert.equal(cfg.plugins['plugin-installer'].enabled, true);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F6-02: Unreachable/failing HTTP 500 mock npm registry during app_reinstall_plugin preserves enabled: true', async () => {
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
      await mcp.initialize();
      const installRes = await mcp.callTool('app_install_plugin', {
        source: 'e2e-npm-plugin',
        sourceType: 'npm',
        registry: registry.url,
      });
      assert.equal(installRes.structuredContent.ok, true, installRes.structuredContent.error);
      await mcp.callTool('app_set_plugin_enabled', {
        dir: 'e2e-npm-plugin',
        scope: 'global',
        enabled: true,
      });

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
      const cfg = await sandbox.readConfig();
      assert.equal(cfg.plugins['e2e-npm-plugin'].enabled, true);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F6-03: Candidate missing plugin.json during overwrite fails before auto-disable', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let lock;
    try {
      const v1Dir = await sandbox.createPluginSource('no-manifest-1', {
        manifest: { name: 'no-manifest', version: '1.0.0' },
        files: { 'marker.txt': 'v1' },
      });
      const v2Missing = await sandbox.createPluginSource('no-manifest-2', {
        manifest: null,
        files: { 'readme.txt': 'missing plugin.json' },
      });

      await mcp.initialize();
      await mcp.callTool('app_install_plugin', { source: v1Dir });
      await mcp.callTool('app_set_plugin_enabled', {
        dir: 'no-manifest',
        scope: 'global',
        enabled: true,
      });

      const installedDir = path.join(sandbox.globalPluginsDir, 'no-manifest');
      lock = await spawnLockedPluginProcess({
        pluginDir: installedDir,
        configPath: sandbox.configPath,
        dirName: 'no-manifest',
        releaseOnDisable: true,
        releaseDelayMs: 50,
      });
      sandbox.trackChild(lock.child);

      const res = await mcp.callTool('app_install_plugin', {
        source: v2Missing,
        targetDirName: 'no-manifest',
        overwrite: true,
      });
      assert.equal(res.structuredContent.ok, false);
      assert.match(res.structuredContent.error, /Missing plugin\.json/i);
      assert.equal(lock.wasReleasedByConfigDisable(), false);
      assert.equal(lock.isAlive(), true);

      const cfg = await sandbox.readConfig();
      assert.equal(cfg.plugins['no-manifest'].enabled, true);
    } finally {
      if (lock) await lock.forceKill();
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F6-04: Uninstalling a disabled plugin preserves remaining plugins entries in config.json', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      await sandbox.placeInstalledPlugin('global', 'p1');
      await sandbox.placeInstalledPlugin('global', 'p2');
      await sandbox.writeConfig({
        plugins: {
          p1: { enabled: false },
          p2: { enabled: true },
        },
      });
      await mcp.initialize();

      const res = await mcp.callTool('app_uninstall_plugin', { dir: 'p1', scope: 'global' });
      assert.equal(res.structuredContent.ok, true);

      const cfg = await sandbox.readConfig();
      assert.equal(cfg.plugins.p2.enabled, true);
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F6-05: Update changing manifest.version while keeping dir preserves enabled: false and updates installMeta', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    try {
      const srcDir = await sandbox.createPluginSource('ver-bump', {
        manifest: { name: 'ver-bump', displayName: 'Ver Bump', version: '1.0.0' },
      });
      await mcp.initialize();
      await mcp.callTool('app_install_plugin', { source: srcDir });
      await mcp.callTool('app_set_plugin_enabled', {
        dir: 'ver-bump',
        scope: 'global',
        enabled: false,
      });

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

      const reg = await sandbox.readInstallRegistry();
      assert.equal(reg.entries['global:ver-bump'].version, '2.0.0');
    } finally {
      await mcp.close();
      await sandbox.cleanup();
    }
  });

  test('E2E-T2-F6-06: Update when config.json had NO entry for p1 auto-disables, releases lock, and restores enabled: true', async () => {
    const sandbox = await createSandbox();
    const mcp = spawnMcpClient({ dataDir: sandbox.dataDir, env: sandbox.env() });
    let lock;
    try {
      const srcDir = await sandbox.createPluginSource('no-cfg-entry', {
        manifest: { name: 'no-cfg-entry', displayName: 'No Cfg Entry', version: '1.0.0' },
        files: { 'marker.txt': 'v1' },
      });
      await mcp.initialize();
      await mcp.callTool('app_install_plugin', { source: srcDir });
      // Confirm config.json does not even exist yet
      await assert.rejects(() => fs.stat(sandbox.configPath), { code: 'ENOENT' });

      const installedDir = path.join(sandbox.globalPluginsDir, 'no-cfg-entry');
      lock = await spawnLockedPluginProcess({
        pluginDir: installedDir,
        configPath: sandbox.configPath,
        dirName: 'no-cfg-entry',
        releaseOnDisable: true,
        releaseDelayMs: 150,
      });
      sandbox.trackChild(lock.child);

      await sandbox.createPluginSource('no-cfg-entry', {
        targetDir: srcDir,
        manifest: { name: 'no-cfg-entry', displayName: 'No Cfg Entry', version: '2.0.0' },
        files: { 'marker.txt': 'v2' },
      });

      const res = await mcp.callTool('app_reinstall_plugin', {
        dir: 'no-cfg-entry',
        scope: 'global',
      });
      assert.equal(res.structuredContent.ok, true, res.structuredContent.error);
      await lock.waitForExit(5000);
      assert.equal(lock.wasReleasedByConfigDisable(), true);

      const marker = await fs.readFile(path.join(installedDir, 'marker.txt'), 'utf8');
      assert.equal(marker, 'v2');
      const cfg = await sandbox.readConfig();
      assert.equal(cfg.plugins['no-cfg-entry'].enabled, true);
    } finally {
      if (lock) await lock.forceKill();
      await mcp.close();
      await sandbox.cleanup();
    }
  });
});
