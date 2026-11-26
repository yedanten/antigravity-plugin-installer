import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { watch as fsWatch } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import {
  extractTarGz,
  installPlugin,
  parsePluginSource,
} from '../server/installer.mjs';
import {
  InstallRegistry,
  getBuiltinPluginsDir,
  getConfigPath,
  isSamePath,
  listInstalledPlugins,
  readAntigravityConfig,
  resolveAgyPath,
  uninstallPlugin,
  validatePluginDirName,
} from '../server/plugins.mjs';
import { parseJsonc, validatePluginDir } from '../server/validator.mjs';
import { stageDeployablePlugin } from '../scripts/install-local.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function buildTarBuffer(entries) {
  const blocks = [];
  for (const { name, content } of entries) {
    const data = Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, Math.min(100, Buffer.byteLength(name)), 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let checksum = 0;
    for (let i = 0; i < 512; i += 1) checksum += header[i];
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');

    blocks.push(header);
    if (data.length > 0) {
      const paddedLen = Math.ceil(data.length / 512) * 512;
      const padded = Buffer.alloc(paddedLen, 0);
      data.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

test('self plugin passes strict validation', async () => {
  const stagedDir = await stageDeployablePlugin(REPO_ROOT);
  try {
    const result = await validatePluginDir(stagedDir, { strict: true });
    assert.equal(result.valid, true, `Validation errors: ${result.errors.join('; ')}`);
    assert.equal(result.manifest.name, 'plugin-installer');
    assert.deepEqual(result.components.skills, ['install-plugin']);
    assert.deepEqual(result.components.mcpServers, ['installer']);
  } finally {
    await fs.rm(stagedDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('parseJsonc preserves URLs inside strings while stripping comments and trailing commas', () => {
  const raw = `\uFEFF{
    // Leading comment
    "name": "demo-plugin",
    "homepage": "https://example.com/docs//path", /* inline comment */
    "keywords": ["one", "two",],
  }`;
  const parsed = parseJsonc(raw);
  assert.equal(parsed.name, 'demo-plugin');
  assert.equal(parsed.homepage, 'https://example.com/docs//path');
  assert.deepEqual(parsed.keywords, ['one', 'two']);
});

test('parsePluginSource classifies GitHub, npm, and local inputs accurately', async () => {
  const gh1 = await parsePluginSource('https://github.com/acme/demo-plugin');
  assert.equal(gh1.type, 'github');
  assert.equal(gh1.owner, 'acme');
  assert.equal(gh1.repo, 'demo-plugin');

  const gh2 = await parsePluginSource('https://github.com/acme/monorepo/tree/main/plugins/sub-kit');
  assert.equal(gh2.type, 'github');
  assert.equal(gh2.ref, 'main');
  assert.equal(gh2.subpath, 'plugins/sub-kit');

  const gh3 = await parsePluginSource('acme/quick-plugin#v2');
  assert.equal(gh3.type, 'github');
  assert.equal(gh3.ref, 'v2');

  const npm1 = await parsePluginSource('@scope/agy-plugin@1.2.3');
  assert.equal(npm1.type, 'npm');
  assert.equal(npm1.packageName, '@scope/agy-plugin');
  assert.equal(npm1.version, '1.2.3');

  const npm2 = await parsePluginSource('https://www.npmjs.com/package/@scope/agy-plugin');
  assert.equal(npm2.type, 'npm');
  assert.equal(npm2.packageName, '@scope/agy-plugin');

  const local1 = await parsePluginSource('"~/my-local-plugin"');
  assert.equal(local1.type, 'local');
  assert.ok(local1.localPath.endsWith(path.join('my-local-plugin')));
});

test('extractTarGz extracts valid files and rejects path traversal', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-tar-test-'));
  try {
    const validGz = buildTarBuffer([
      { name: 'package/plugin.json', content: '{"name":"tar-demo"}' },
      { name: 'package/skills/hi/SKILL.md', content: '# Hi' },
    ]);
    await extractTarGz(validGz, path.join(tmpDir, 'ok'));
    const manifest = await fs.readFile(path.join(tmpDir, 'ok', 'package', 'plugin.json'), 'utf8');
    assert.equal(manifest, '{"name":"tar-demo"}');

    const evilGz = buildTarBuffer([
      { name: '../../escape.txt', content: 'pwned' },
    ]);
    await assert.rejects(
      () => extractTarGz(evilGz, path.join(tmpDir, 'evil')),
      /Unsafe archive entry/,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('local plugin install (copy & link), overwrite guard, list, and safe uninstall', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-install-sandbox-'));
  const prevPluginsDir = process.env.ANTIGRAVITY_PLUGINS_DIR;
  const prevBuiltinDir = process.env.ANTIGRAVITY_BUILTIN_PLUGINS_DIR;
  const prevConfigPath = process.env.ANTIGRAVITY_CONFIG_PATH;

  try {
    const pluginsDir = path.join(sandbox, 'global-plugins');
    const builtinDir = path.join(sandbox, 'builtin-plugins');
    const dataDir = path.join(sandbox, 'installer-data');
    const configPath = path.join(sandbox, 'config.json');
    const srcPlugin = path.join(sandbox, 'sample-src');

    process.env.ANTIGRAVITY_PLUGINS_DIR = pluginsDir;
    process.env.ANTIGRAVITY_BUILTIN_PLUGINS_DIR = builtinDir;
    process.env.ANTIGRAVITY_CONFIG_PATH = configPath;
    await fs.writeFile(configPath, '{"plugins":{}}', 'utf8');

    await fs.mkdir(path.join(srcPlugin, 'skills', 'greet'), { recursive: true });
    await fs.mkdir(path.join(srcPlugin, 'assets'), { recursive: true });
    await fs.writeFile(
      path.join(srcPlugin, 'plugin.json'),
      JSON.stringify({
        name: 'sample-demo',
        displayName: 'Sample Demo',
        version: '0.2.0',
        description: 'Demo plugin for automated tests.',
        logo: 'assets/logo.svg',
      }),
    );
    await fs.writeFile(
      path.join(srcPlugin, 'assets', 'logo.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>',
    );
    await fs.writeFile(
      path.join(srcPlugin, 'skills', 'greet', 'SKILL.md'),
      '---\nname: greet\ndescription: demo\n---\nHello\n',
    );

    const registry = new InstallRegistry(dataDir);

    // 1. Copy install
    const res1 = await installPlugin({
      source: srcPlugin,
      mode: 'copy',
      scope: 'global',
      installRegistry: registry,
    });
    assert.equal(res1.ok, true);
    assert.equal(res1.plugin.dir, 'sample-demo');
    assert.equal(res1.plugin.mode, 'copy');

    // 2. Duplicate without overwrite fails with PLUGIN_EXISTS
    await assert.rejects(
      () =>
        installPlugin({
          source: srcPlugin,
          mode: 'copy',
          scope: 'global',
          overwrite: false,
          installRegistry: registry,
        }),
      (err) => err.code === 'PLUGIN_EXISTS',
    );

    // 3. Overwrite with link mode succeeds
    const res2 = await installPlugin({
      source: srcPlugin,
      mode: 'link',
      scope: 'global',
      overwrite: true,
      installRegistry: registry,
    });
    assert.equal(res2.ok, true);
    assert.equal(res2.plugin.mode, 'link');

    // 4. List installed plugins includes logo data URI & symlink flag
    const inventory = await listInstalledPlugins({ registry });
    assert.equal(inventory.counts.global, 1);
    assert.equal(inventory.plugins[0].dir, 'sample-demo');
    assert.equal(inventory.plugins[0].isSymlink, true);
    assert.ok(inventory.plugins[0].logoDataUri?.startsWith('data:image/svg+xml;base64,'));

    // 5. Uninstall removes symlink without touching original source folder
    const removed = await uninstallPlugin({
      dir: 'sample-demo',
      scope: 'global',
      registry,
    });
    assert.equal(removed.ok, true);
    assert.equal(removed.wasSymlink, true);
    const srcStillExists = await fs.stat(path.join(srcPlugin, 'plugin.json'));
    assert.equal(srcStillExists.isFile(), true);

    // 6. Builtin uninstall is always blocked
    await assert.rejects(
      () => uninstallPlugin({ dir: 'swarm', scope: 'builtin', registry }),
      /Built-in plugins cannot be uninstalled/,
    );
  } finally {
    if (prevPluginsDir === undefined) delete process.env.ANTIGRAVITY_PLUGINS_DIR;
    else process.env.ANTIGRAVITY_PLUGINS_DIR = prevPluginsDir;
    if (prevBuiltinDir === undefined) delete process.env.ANTIGRAVITY_BUILTIN_PLUGINS_DIR;
    else process.env.ANTIGRAVITY_BUILTIN_PLUGINS_DIR = prevBuiltinDir;
    if (prevConfigPath === undefined) delete process.env.ANTIGRAVITY_CONFIG_PATH;
    else process.env.ANTIGRAVITY_CONFIG_PATH = prevConfigPath;
    await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('MCP stdio server responds to initialize, tools/list, resources/read, and tools/call', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-mcp-test-'));
  const configPath = path.join(sandbox, 'config.json');
  await fs.writeFile(configPath, '{"plugins":{}}', 'utf8');
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'server', 'index.mjs'), '--data-dir', sandbox], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ANTIGRAVITY_PLUGINS_DIR: path.join(sandbox, 'plugins'),
      ANTIGRAVITY_BUILTIN_PLUGINS_DIR: path.join(sandbox, 'builtin'),
      ANTIGRAVITY_CONFIG_PATH: configPath,
    },
  });

  let stdoutBuf = '';
  const pending = new Map();

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const resolver = pending.get(msg.id);
      if (resolver) {
        pending.delete(msg.id);
        resolver(msg);
      }
    }
  });

  const rpc = (id, method, params = {}) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${method}`)), 5000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  try {
    const init = await rpc(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.equal(init.result.serverInfo.name, 'plugin-installer');

    const toolsList = await rpc(2, 'tools/list');
    const openTool = toolsList.result.tools.find((t) => t.name === 'open_plugin_installer');
    assert.ok(openTool, 'open_plugin_installer should be registered');
    assert.equal(openTool._meta.ui.resourceUri, 'ui://plugin-installer/app.html');
    assert.equal(openTool._meta['com.google.antigravity/ui'].entrypoints.length, 2);

    const appOnlyTool = toolsList.result.tools.find((t) => t.name === 'app_install_plugin');
    assert.deepEqual(appOnlyTool._meta.ui.visibility, ['app']);

    const resRead = await rpc(3, 'resources/read', { uri: 'ui://plugin-installer/app.html' });
    assert.equal(resRead.result.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.ok(resRead.result.contents[0].text.includes('<!doctype html>'));

    const callOpen = await rpc(4, 'tools/call', { name: 'open_plugin_installer', arguments: {} });
    assert.equal(callOpen.result.structuredContent.view, 'manager');
    assert.equal(callOpen.result.structuredContent.counts.total, 0);
  } finally {
    const exitPromise = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once('close', resolve);
      setTimeout(resolve, 1000);
    });
    child.stdin.end();
    child.kill();
    await exitPromise;
    await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('R1: v2.35.1 validator rules, .gemini-plugin discovery, sidecars, BOM/JSONC, and agy path discovery', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-r1-compat-'));
  const prevBuiltin = process.env.ANTIGRAVITY_BUILTIN_PLUGINS_DIR;
  const prevAppData = process.env.ANTIGRAVITY_APP_DATA_DIR;
  const prevPath = process.env.PATH;

  try {
    // 1. .gemini-plugin/plugin.json with category, extensions, BOM, and sidecars
    const geminiPluginDir = path.join(sandbox, 'gemini-ext-plugin');
    await fs.mkdir(path.join(geminiPluginDir, '.gemini-plugin'), { recursive: true });
    await fs.mkdir(path.join(geminiPluginDir, 'sidecars', 'helper'), { recursive: true });
    await fs.writeFile(
      path.join(geminiPluginDir, '.gemini-plugin', 'plugin.json'),
      `\uFEFF${JSON.stringify({
        name: 'gemini-ext',
        displayName: 'Gemini Extension',
        version: '1.0.0',
        category: 'productivity',
        extensions: ['ext-a'],
      })}`,
      'utf8',
    );
    await fs.writeFile(
      path.join(geminiPluginDir, 'sidecars', 'helper', 'sidecar.json'),
      `\uFEFF${JSON.stringify({ name: 'helper', command: 'node', args: ['index.js'] })}`,
      'utf8',
    );

    const vOk = await validatePluginDir(geminiPluginDir, { strict: true });
    assert.equal(vOk.valid, true, `Expected valid, got: ${vOk.errors.join('; ')}`);
    assert.deepEqual(vOk.components.sidecars, ['helper']);

    // 2. mcp_config.json mutual exclusion between url/serverUrl and command/args/env
    const hybridMcpDir = path.join(sandbox, 'hybrid-mcp');
    await fs.mkdir(hybridMcpDir, { recursive: true });
    await fs.writeFile(path.join(hybridMcpDir, 'plugin.json'), '{"name":"hybrid-mcp","version":"1.0.0"}');
    await fs.writeFile(
      path.join(hybridMcpDir, 'mcp_config.json'),
      JSON.stringify({ mcpServers: { bad: { url: 'https://example.com/mcp', command: 'npx' } } }),
    );
    const vHybrid = await validatePluginDir(hybridMcpDir, { strict: false });
    assert.equal(vHybrid.valid, false);

    // 3. Misplaced files emit warnings in non-strict mode and errors in strict mode
    const misplacedDir = path.join(sandbox, 'misplaced-files');
    await fs.mkdir(path.join(misplacedDir, 'hooks'), { recursive: true });
    await fs.writeFile(path.join(misplacedDir, 'plugin.json'), '{"name":"misplaced-files","version":"1.0.0"}');
    await fs.writeFile(path.join(misplacedDir, 'AGENTS.md'), '# root agents\n');
    await fs.writeFile(path.join(misplacedDir, '.mcp.json'), '{}');
    await fs.writeFile(path.join(misplacedDir, 'hooks', 'hooks.json'), '{}');

    const vWarn = await validatePluginDir(misplacedDir, { strict: false });
    assert.equal(vWarn.valid, true);
    assert.ok(vWarn.warnings.length >= 3);

    const vStrict = await validatePluginDir(misplacedDir, { strict: true });
    assert.equal(vStrict.valid, false);
    assert.ok(vStrict.errors.length >= 3);

    // 4. ANTIGRAVITY_APP_DATA_DIR fallback for builtin plugins & resolveAgyPath
    delete process.env.ANTIGRAVITY_BUILTIN_PLUGINS_DIR;
    process.env.ANTIGRAVITY_APP_DATA_DIR = path.join(sandbox, 'appdata');
    assert.equal(
      getBuiltinPluginsDir(),
      path.join(path.resolve(sandbox, 'appdata'), 'builtin', 'plugins'),
    );

    const fakeBinDir = path.join(sandbox, 'bin');
    await fs.mkdir(fakeBinDir, { recursive: true });
    const fakeAgyName = process.platform === 'win32' ? 'agy.cmd' : 'agy';
    const fakeAgyPath = path.join(fakeBinDir, fakeAgyName);
    await fs.writeFile(fakeAgyPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', {
      mode: 0o755,
    });
    process.env.PATH = fakeBinDir;
    const resolvedAgy = await resolveAgyPath();
    assert.equal(resolvedAgy, fakeAgyPath);
  } finally {
    if (prevBuiltin === undefined) delete process.env.ANTIGRAVITY_BUILTIN_PLUGINS_DIR;
    else process.env.ANTIGRAVITY_BUILTIN_PLUGINS_DIR = prevBuiltin;
    if (prevAppData === undefined) delete process.env.ANTIGRAVITY_APP_DATA_DIR;
    else process.env.ANTIGRAVITY_APP_DATA_DIR = prevAppData;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('R2: config.json is read-only (BOM/JSONC/dir-keyed), never mutated, and validatePluginDirName guards invalid names', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-r2-config-'));
  const prevConfig = process.env.ANTIGRAVITY_CONFIG_PATH;
  const prevPluginsDir = process.env.ANTIGRAVITY_PLUGINS_DIR;
  const prevBuiltinDir = process.env.ANTIGRAVITY_BUILTIN_PLUGINS_DIR;

  try {
    const configPath = path.join(sandbox, 'config.json');
    const pluginsDir = path.join(sandbox, 'plugins');
    const builtinDir = path.join(sandbox, 'builtin');
    process.env.ANTIGRAVITY_CONFIG_PATH = configPath;
    process.env.ANTIGRAVITY_PLUGINS_DIR = pluginsDir;
    process.env.ANTIGRAVITY_BUILTIN_PLUGINS_DIR = builtinDir;
    assert.equal(getConfigPath(), path.resolve(configPath));

    await fs.mkdir(path.join(pluginsDir, 'dir-slug'), { recursive: true });
    await fs.writeFile(
      path.join(pluginsDir, 'dir-slug', 'plugin.json'),
      JSON.stringify({ name: 'manifest-slug', displayName: 'Dir Slug', version: '1.0.0' }),
    );
    await fs.mkdir(path.join(pluginsDir, 'My_Custom.Plugin'), { recursive: true });
    await fs.writeFile(
      path.join(pluginsDir, 'My_Custom.Plugin', 'plugin.json'),
      JSON.stringify({ name: 'my-custom', displayName: 'My Custom', version: '1.0.0' }),
    );

    const originalRaw = `\uFEFF// BOM + JSONC config\n${JSON.stringify(
      {
        userSettings: { theme: 'dark', telemetry: false },
        sidecars: { inspector: { port: 9123 } },
        plugins: {
          'dir-slug': { enabled: false, note: 'existing' },
          'My_Custom.Plugin': { enabled: true },
        },
      },
      null,
      2,
    )}`;
    await fs.writeFile(configPath, originalRaw, 'utf8');

    const cfg = await readAntigravityConfig();
    assert.deepEqual(cfg.userSettings, { theme: 'dark', telemetry: false });
    assert.deepEqual(cfg.sidecars, { inspector: { port: 9123 } });
    assert.equal(cfg.plugins['dir-slug'].enabled, false);

    const inv = await listInstalledPlugins({});
    const dirSlug = inv.plugins.find((p) => p.dir === 'dir-slug');
    const customDir = inv.plugins.find((p) => p.dir === 'My_Custom.Plugin');
    assert.equal(dirSlug.enabled, false);
    assert.equal(dirSlug.customizationUri, 'customization://dir-slug');
    assert.equal(customDir.enabled, true);
    assert.equal(customDir.customizationUri, 'customization://My_Custom.Plugin');

    // config.json must remain byte-for-byte untouched
    assert.equal(await fs.readFile(configPath, 'utf8'), originalRaw);

    // Unsafe names remain rejected
    for (const badName of ['', '   ', ' bad ', '.', '..', '../evil', 'a/b', 'a\\b', 'a\0b', 'a\nb', '__proto__', 'constructor', 'prototype']) {
      assert.throws(() => validatePluginDirName(badName), /Invalid plugin directory name/);
    }
  } finally {
    if (prevConfig === undefined) delete process.env.ANTIGRAVITY_CONFIG_PATH;
    else process.env.ANTIGRAVITY_CONFIG_PATH = prevConfig;
    if (prevPluginsDir === undefined) delete process.env.ANTIGRAVITY_PLUGINS_DIR;
    else process.env.ANTIGRAVITY_PLUGINS_DIR = prevPluginsDir;
    if (prevBuiltinDir === undefined) delete process.env.ANTIGRAVITY_BUILTIN_PLUGINS_DIR;
    else process.env.ANTIGRAVITY_BUILTIN_PLUGINS_DIR = prevBuiltinDir;
    await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('R2 + R3: MCP stdio does not expose app_set_plugin_enabled and app_reinstall_plugin preserves config.json byte-for-byte', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-mcp-r2-r3-'));
  const pluginsDir = path.join(sandbox, 'plugins');
  const builtinDir = path.join(sandbox, 'builtin');
  const dataDir = path.join(sandbox, 'data');
  const configPath = path.join(sandbox, 'config.json');
  const srcDir = path.join(sandbox, 'src-plugin');

  await fs.mkdir(path.join(builtinDir, 'builtin-tool'), { recursive: true });
  await fs.writeFile(path.join(builtinDir, 'builtin-tool', 'plugin.json'), '{"name":"builtin-tool","displayName":"Builtin Tool"}');

  await fs.mkdir(srcDir, { recursive: true });
  await fs.writeFile(
    path.join(srcDir, 'plugin.json'),
    JSON.stringify({ name: 'manifest-slug', displayName: 'Dir Mismatch Plugin', version: '1.0.0' }),
  );
  const initialConfig = JSON.stringify(
    {
      userSettings: { locale: 'zh-CN' },
      sidecars: { keep: true },
      plugins: { 'dir-slug': { enabled: false }, 'builtin-tool': { enabled: false } },
    },
    null,
    2,
  );
  await fs.writeFile(configPath, initialConfig, 'utf8');

  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'server', 'index.mjs'), '--data-dir', dataDir], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ANTIGRAVITY_PLUGINS_DIR: pluginsDir,
      ANTIGRAVITY_BUILTIN_PLUGINS_DIR: builtinDir,
      ANTIGRAVITY_CONFIG_PATH: configPath,
    },
  });

  let stdoutBuf = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const resolver = pending.get(msg.id);
      if (resolver) {
        pending.delete(msg.id);
        resolver(msg);
      }
    }
  });

  const rpc = (id, method, params = {}) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${method}`)), 8000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  try {
    await rpc(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });

    const toolsList = await rpc(2, 'tools/list');
    assert.equal(
      toolsList.result.tools.some((t) => t.name === 'app_set_plugin_enabled'),
      false,
      'app_set_plugin_enabled must not be registered',
    );

    // Install with targetDirName !== manifest.name
    const inst = await rpc(3, 'tools/call', {
      name: 'app_install_plugin',
      arguments: { source: srcDir, targetDirName: 'dir-slug', scope: 'global' },
    });
    assert.equal(inst.result.structuredContent.ok, true);
    assert.equal(inst.result.structuredContent.install.plugin.customizationUri, 'customization://dir-slug');

    // Verify app_list_plugins reflects disabled state from config.json keyed by dir-slug
    const listRes = await rpc(4, 'tools/call', { name: 'app_list_plugins', arguments: {} });
    const dirSlugCard = listRes.result.structuredContent.plugins.find((p) => p.dir === 'dir-slug');
    assert.equal(dirSlugCard.enabled, false);
    assert.equal(dirSlugCard.customizationUri, 'customization://dir-slug');
    const builtinCard = listRes.result.structuredContent.plugins.find((p) => p.dir === 'builtin-tool');
    assert.equal(builtinCard.enabled, false);
    assert.equal(builtinCard.customizationUri, 'customization://builtin-tool');

    // Reinstall disabled plugin -> updates version and never touches config.json
    await fs.writeFile(
      path.join(srcDir, 'plugin.json'),
      JSON.stringify({ name: 'manifest-slug', displayName: 'Dir Mismatch Plugin', version: '1.1.0' }),
    );
    const reinst = await rpc(5, 'tools/call', {
      name: 'app_reinstall_plugin',
      arguments: { dir: 'dir-slug', scope: 'global' },
    });
    assert.equal(reinst.result.structuredContent.ok, true);
    const updatedCard = reinst.result.structuredContent.inventory.plugins.find((p) => p.dir === 'dir-slug');
    assert.equal(updatedCard.version, '1.1.0');
    assert.equal(updatedCard.enabled, false);

    // config.json must still be byte-for-byte identical
    assert.equal(await fs.readFile(configPath, 'utf8'), initialConfig);
  } finally {
    const exitPromise = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once('close', resolve);
      setTimeout(resolve, 1000);
    });
    child.stdin.end();
    child.kill();
    await exitPromise;
    await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('R3: installPlugin retries transient EBUSY without modifying config.json and gives actionable lock guidance on persistent locks', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-r3-update-'));
  const prevPluginsDir = process.env.ANTIGRAVITY_PLUGINS_DIR;
  const prevConfigPath = process.env.ANTIGRAVITY_CONFIG_PATH;

  try {
    const pluginsDir = path.join(sandbox, 'plugins');
    const configPath = path.join(sandbox, 'config.json');
    const srcDir = path.join(sandbox, 'src-plugin');
    process.env.ANTIGRAVITY_PLUGINS_DIR = pluginsDir;
    process.env.ANTIGRAVITY_CONFIG_PATH = configPath;

    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, 'plugin.json'), '{"name":"lock-demo","version":"1.0.0"}');
    const initialConfig = '{"plugins":{"lock-demo":{"enabled":true}},"userSettings":{"theme":"dark"}}';
    await fs.writeFile(configPath, initialConfig, 'utf8');

    // Initial install
    await installPlugin({ source: srcDir, scope: 'global' });

    // 1. Overwrite plugin while simulating transient EBUSY lock on removal (config.json untouched)
    await fs.writeFile(path.join(srcDir, 'plugin.json'), '{"name":"lock-demo","version":"2.0.0"}');
    let rmAttempts = 0;

    const resOk = await installPlugin({
      source: srcDir,
      scope: 'global',
      overwrite: true,
      removeRetries: 4,
      removeRetryDelayMs: 5,
      removeTarget: async (destPath, { attempt }) => {
        rmAttempts = attempt;
        if (attempt < 3) {
          const e = new Error('EBUSY: resource busy or locked');
          e.code = 'EBUSY';
          throw e;
        }
        await fs.rm(destPath, { recursive: true, force: true });
      },
    });

    assert.equal(rmAttempts, 3);
    assert.equal(resOk.ok, true);
    assert.equal(resOk.overwrote, true);
    assert.equal(resOk.enabled, true);
    assert.equal(await fs.readFile(configPath, 'utf8'), initialConfig);

    // 2. Failed source validation never touches existing files or config.json
    const brokenSrc = path.join(sandbox, 'broken-src');
    await fs.mkdir(brokenSrc, { recursive: true });
    await fs.writeFile(path.join(brokenSrc, 'plugin.json'), '{bad json');
    await assert.rejects(
      () =>
        installPlugin({
          source: brokenSrc,
          targetDirName: 'lock-demo',
          scope: 'global',
          overwrite: true,
        }),
      /Invalid JSON/,
    );
    assert.equal(await fs.readFile(configPath, 'utf8'), initialConfig);

    // 3. Persistent EBUSY failure reports locked=true + customizationUri guidance without mutating config.json
    await assert.rejects(
      () =>
        installPlugin({
          source: srcDir,
          scope: 'global',
          overwrite: true,
          removeRetries: 1,
          removeRetryDelayMs: 5,
          removeTarget: async () => {
            const e = new Error('EBUSY: still locked');
            e.code = 'EBUSY';
            throw e;
          },
        }),
      (err) => {
        assert.match(err.message, /files are locked \(EBUSY\)/);
        assert.match(err.message, /customization:\/\/lock-demo/);
        assert.equal(err.locked, true);
        assert.equal(err.customizationUri, 'customization://lock-demo');
        return true;
      },
    );
    assert.equal(await fs.readFile(configPath, 'utf8'), initialConfig);

    // 4. Live self-overwrite guard blocks replacing running pluginRoot
    await assert.rejects(
      () =>
        installPlugin({
          source: srcDir,
          scope: 'global',
          overwrite: true,
          pluginRoot: path.join(pluginsDir, 'lock-demo'),
        }),
      (err) => err.code === 'SELF_UPDATE_BLOCKED',
    );
  } finally {
    if (prevPluginsDir === undefined) delete process.env.ANTIGRAVITY_PLUGINS_DIR;
    else process.env.ANTIGRAVITY_PLUGINS_DIR = prevPluginsDir;
    if (prevConfigPath === undefined) delete process.env.ANTIGRAVITY_CONFIG_PATH;
    else process.env.ANTIGRAVITY_CONFIG_PATH = prevConfigPath;
    await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('R3 hardening: atomic backup/swap keeps files intact on permanent lock and rolls back on post-backup failure', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-r3-atomic-'));
  const prevPluginsDir = process.env.ANTIGRAVITY_PLUGINS_DIR;
  const prevConfigPath = process.env.ANTIGRAVITY_CONFIG_PATH;
  let lockerProc = null;

  try {
    const pluginsDir = path.join(sandbox, 'plugins');
    const configPath = path.join(sandbox, 'config.json');
    const srcV1 = path.join(sandbox, 'src-v1');
    const srcV2 = path.join(sandbox, 'src-v2');
    process.env.ANTIGRAVITY_PLUGINS_DIR = pluginsDir;
    process.env.ANTIGRAVITY_CONFIG_PATH = configPath;

    await fs.mkdir(srcV1, { recursive: true });
    await fs.writeFile(path.join(srcV1, 'aaa-first.txt'), 'keep-me-v1', 'utf8');
    await fs.writeFile(
      path.join(srcV1, 'plugin.json'),
      JSON.stringify({ name: 'perm-lock-demo', version: '1.0.0' }),
    );
    await fs.writeFile(path.join(srcV1, 'zzz-locked.txt'), 'locked-content', 'utf8');

    await fs.mkdir(srcV2, { recursive: true });
    await fs.writeFile(path.join(srcV2, 'aaa-first.txt'), 'updated-v2', 'utf8');
    await fs.writeFile(
      path.join(srcV2, 'plugin.json'),
      JSON.stringify({ name: 'perm-lock-demo', version: '2.0.0' }),
    );

    await fs.writeFile(configPath, '{"plugins":{}}', 'utf8');
    await installPlugin({ source: srcV1, scope: 'global' });

    const destPath = path.join(pluginsDir, 'perm-lock-demo');
    const lockedFile = path.join(destPath, 'zzz-locked.txt');

    if (process.platform === 'win32') {
      lockerProc = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `$fs = [System.IO.File]::Open($env:LOCK_TARGET, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); [Console]::Out.WriteLine('LOCKED'); [Console]::In.ReadLine() | Out-Null; $fs.Dispose()`,
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, LOCK_TARGET: lockedFile },
        },
      );

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for Windows file lock')), 8000);
        let out = '';
        lockerProc.stdout.setEncoding('utf8');
        lockerProc.stdout.on('data', (chunk) => {
          out += chunk;
          if (out.includes('LOCKED')) {
            clearTimeout(timer);
            resolve();
          }
        });
        lockerProc.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Locker exited early with code ${code}`));
        });
      });

      await assert.rejects(
        () =>
          installPlugin({
            source: srcV2,
            scope: 'global',
            overwrite: true,
            disableSettleMs: 0,
            removeRetries: 2,
            removeRetryDelayMs: 25,
          }),
        /files are locked/,
      );
    } else {
      await assert.rejects(
        () =>
          installPlugin({
            source: srcV2,
            scope: 'global',
            overwrite: true,
            disableSettleMs: 0,
            removeRetries: 1,
            removeRetryDelayMs: 10,
            moveExistingToBackup: async () => {
              const e = new Error('EPERM: simulated atomic rename lock');
              e.code = 'EPERM';
              throw e;
            },
          }),
        /files are locked/,
      );
    }

    // All existing files in destPath must remain 100% intact and config.json untouched
    assert.equal(await fs.readFile(path.join(destPath, 'aaa-first.txt'), 'utf8'), 'keep-me-v1');
    const manifestAfterLock = JSON.parse(await fs.readFile(path.join(destPath, 'plugin.json'), 'utf8'));
    assert.equal(manifestAfterLock.version, '1.0.0');
    assert.equal((await fs.lstat(lockedFile)).isFile(), true);
    assert.equal(await fs.readFile(configPath, 'utf8'), '{"plugins":{}}');

    // Release the Windows file lock and confirm locked file content was also untouched
    if (lockerProc) {
      const proc = lockerProc;
      lockerProc = null;
      await new Promise((resolve) => {
        const killTimer = setTimeout(() => {
          proc.kill();
          resolve();
        }, 2000);
        proc.once('close', () => {
          clearTimeout(killTimer);
          resolve();
        });
        proc.stdin.write('\n');
        proc.stdin.end();
      });
    }
    assert.equal(await fs.readFile(lockedFile, 'utf8'), 'locked-content');

    // Post-backup failure (after rename succeeded and v2 was copied) must restore v1 without touching config.json
    await assert.rejects(
      () =>
        installPlugin({
          source: srcV2,
          scope: 'global',
          overwrite: true,
          installRegistry: {
            record: async () => {
              throw new Error('Simulated registry failure');
            },
          },
        }),
      /Simulated registry failure/,
    );

    const manifestAfterRollback = JSON.parse(await fs.readFile(path.join(destPath, 'plugin.json'), 'utf8'));
    assert.equal(manifestAfterRollback.version, '1.0.0');
    assert.equal(await fs.readFile(path.join(destPath, 'aaa-first.txt'), 'utf8'), 'keep-me-v1');
    assert.equal(await fs.readFile(configPath, 'utf8'), '{"plugins":{}}');
    const entriesAfterRollback = await fs.readdir(pluginsDir);
    assert.deepEqual(entriesAfterRollback, ['perm-lock-demo']);

    // Unlocked update succeeds and cleans up backup directory without touching config.json
    const resSuccess = await installPlugin({
      source: srcV2,
      scope: 'global',
      overwrite: true,
    });
    assert.equal(resSuccess.ok, true);
    assert.equal(resSuccess.overwrote, true);
    assert.equal(resSuccess.enabled, true);
    assert.equal(await fs.readFile(configPath, 'utf8'), '{"plugins":{}}');
    const manifestV2 = JSON.parse(await fs.readFile(path.join(destPath, 'plugin.json'), 'utf8'));
    assert.equal(manifestV2.version, '2.0.0');
    const entriesAfterSuccess = await fs.readdir(pluginsDir);
    assert.deepEqual(entriesAfterSuccess, ['perm-lock-demo']);
  } finally {
    if (lockerProc && lockerProc.exitCode === null) {
      lockerProc.kill();
    }
    if (prevPluginsDir === undefined) delete process.env.ANTIGRAVITY_PLUGINS_DIR;
    else process.env.ANTIGRAVITY_PLUGINS_DIR = prevPluginsDir;
    if (prevConfigPath === undefined) delete process.env.ANTIGRAVITY_CONFIG_PATH;
    else process.env.ANTIGRAVITY_CONFIG_PATH = prevConfigPath;
    await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('R3 hardening: SELF_UPDATE_BLOCKED and SELF_UNINSTALL_BLOCKED catch symlinks/junctions and case mismatches', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-self-guard-'));
  const prevPluginsDir = process.env.ANTIGRAVITY_PLUGINS_DIR;
  const prevConfigPath = process.env.ANTIGRAVITY_CONFIG_PATH;
  let child = null;

  const flipDriveCase = (p) => {
    if (process.platform !== 'win32' || !/^[A-Za-z]:/.test(p)) return p;
    const ch = p[0];
    return (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()) + p.slice(1);
  };

  try {
    const pluginsDir = path.join(sandbox, 'plugins');
    const builtinDir = path.join(sandbox, 'builtin');
    const dataDir = path.join(sandbox, 'data');
    const configPath = path.join(sandbox, 'config.json');
    const fakeSelfRoot = path.join(sandbox, 'fake-self-root');
    const updateSrc = path.join(sandbox, 'update-src');

    process.env.ANTIGRAVITY_PLUGINS_DIR = pluginsDir;
    process.env.ANTIGRAVITY_CONFIG_PATH = configPath;

    await fs.mkdir(pluginsDir, { recursive: true });
    await fs.mkdir(builtinDir, { recursive: true });
    await fs.mkdir(fakeSelfRoot, { recursive: true });
    await fs.mkdir(updateSrc, { recursive: true });
    await fs.writeFile(path.join(fakeSelfRoot, 'plugin.json'), '{"name":"self-link","version":"1.0.0"}');
    await fs.writeFile(path.join(updateSrc, 'plugin.json'), '{"name":"self-link","version":"2.0.0"}');
    await fs.writeFile(configPath, '{"plugins":{}}', 'utf8');

    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    const linkedInstall = path.join(pluginsDir, 'self-link');
    await fs.symlink(fakeSelfRoot, linkedInstall, linkType);

    // isSamePath matches junctions/symlinks and Windows case differences
    assert.equal(await isSamePath(linkedInstall, fakeSelfRoot), true);
    if (process.platform === 'win32') {
      assert.equal(await isSamePath(flipDriveCase(fakeSelfRoot), fakeSelfRoot), true);
    }

    // SELF_UPDATE_BLOCKED via junction/symlink
    await assert.rejects(
      () =>
        installPlugin({
          source: updateSrc,
          targetDirName: 'self-link',
          scope: 'global',
          overwrite: true,
          pluginRoot: fakeSelfRoot,
        }),
      (err) => err.code === 'SELF_UPDATE_BLOCKED',
    );

    // SELF_UPDATE_BLOCKED via Windows drive/path case mismatch
    if (process.platform === 'win32') {
      await fs.writeFile(path.join(updateSrc, 'plugin.json'), '{"name":"self-case","version":"1.0.0"}');
      await installPlugin({ source: updateSrc, scope: 'global' });
      const caseDir = path.join(pluginsDir, 'self-case');
      await assert.rejects(
        () =>
          installPlugin({
            source: updateSrc,
            targetDirName: 'self-case',
            scope: 'global',
            overwrite: true,
            pluginRoot: flipDriveCase(caseDir).replace('self-case', 'SELF-CASE'),
          }),
        (err) => err.code === 'SELF_UPDATE_BLOCKED',
      );
    }

    // SELF_UNINSTALL_BLOCKED via junction/symlink directly
    await assert.rejects(
      () =>
        uninstallPlugin({
          dir: 'self-link',
          scope: 'global',
          pluginRoot: fakeSelfRoot,
        }),
      (err) => err.code === 'SELF_UNINSTALL_BLOCKED',
    );
    assert.equal((await fs.lstat(linkedInstall)).isSymbolicLink(), true);

    // SELF_DISABLE_BLOCKED and SELF_UNINSTALL_BLOCKED over MCP stdio with junction + flipped Windows drive casing
    const selfJunction = path.join(pluginsDir, 'plugin-installer');
    await fs.symlink(REPO_ROOT, selfJunction, linkType);

    child = spawn(process.execPath, [path.join(REPO_ROOT, 'server', 'index.mjs'), '--data-dir', dataDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ANTIGRAVITY_PLUGINS_DIR: flipDriveCase(pluginsDir),
        ANTIGRAVITY_BUILTIN_PLUGINS_DIR: builtinDir,
        ANTIGRAVITY_CONFIG_PATH: configPath,
      },
    });

    let stdoutBuf = '';
    const pending = new Map();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        const resolver = pending.get(msg.id);
        if (resolver) {
          pending.delete(msg.id);
          resolver(msg);
        }
      }
    });

    const rpc = (id, method, params = {}) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${method}`)), 8000);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });

    await rpc(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });

    const uninstRes = await rpc(2, 'tools/call', {
      name: 'app_uninstall_plugin',
      arguments: { dir: 'plugin-installer', scope: 'global' },
    });
    assert.equal(uninstRes.result.structuredContent.ok, false);
    assert.equal(uninstRes.result.structuredContent.code, 'SELF_UNINSTALL_BLOCKED');
    assert.equal((await fs.lstat(selfJunction)).isSymbolicLink(), true);
    assert.equal((await fs.stat(path.join(REPO_ROOT, 'plugin.json'))).isFile(), true);
  } finally {
    if (child) {
      const exitPromise = new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once('close', resolve);
        setTimeout(resolve, 1000);
      });
      child.stdin.end();
      child.kill();
      await exitPromise;
    }
    if (prevPluginsDir === undefined) delete process.env.ANTIGRAVITY_PLUGINS_DIR;
    else process.env.ANTIGRAVITY_PLUGINS_DIR = prevPluginsDir;
    if (prevConfigPath === undefined) delete process.env.ANTIGRAVITY_CONFIG_PATH;
    else process.env.ANTIGRAVITY_CONFIG_PATH = prevConfigPath;
    await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('R3 hardening: symlink/junction overwrite with mode=copy failing mid-copy removes partial dir and restores junction without touching config.json', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-link-copy-rollback-'));
  const prevPluginsDir = process.env.ANTIGRAVITY_PLUGINS_DIR;
  const prevConfigPath = process.env.ANTIGRAVITY_CONFIG_PATH;
  let lockerProc = null;

  try {
    const pluginsDir = path.join(sandbox, 'plugins');
    const dataDir = path.join(sandbox, 'data');
    const configPath = path.join(sandbox, 'config.json');
    const srcV1 = path.join(sandbox, 'src-v1');
    const srcV2 = path.join(sandbox, 'src-v2');

    process.env.ANTIGRAVITY_PLUGINS_DIR = pluginsDir;
    process.env.ANTIGRAVITY_CONFIG_PATH = configPath;

    await fs.mkdir(srcV1, { recursive: true });
    await fs.writeFile(
      path.join(srcV1, 'plugin.json'),
      JSON.stringify({ name: 'link-rollback', version: '1.0.0' }),
    );
    await fs.writeFile(path.join(srcV1, 'aaa-v1.txt'), 'v1-intact', 'utf8');

    await fs.mkdir(srcV2, { recursive: true });
    await fs.writeFile(path.join(srcV2, 'aaa-first.txt'), 'partial-v2', 'utf8');
    await fs.writeFile(
      path.join(srcV2, 'plugin.json'),
      JSON.stringify({ name: 'link-rollback', version: '2.0.0' }),
    );
    const v2LockedFile = path.join(srcV2, 'zzz-locked.txt');
    await fs.writeFile(v2LockedFile, 'locked-v2-source', 'utf8');
    const initialConfig = '{"plugins":{"link-rollback":{"enabled":true}}}';
    await fs.writeFile(configPath, initialConfig, 'utf8');

    const registry = new InstallRegistry(dataDir);
    await installPlugin({
      source: srcV1,
      sourceType: 'local',
      mode: 'link',
      scope: 'global',
      installRegistry: registry,
    });

    const destPath = path.join(pluginsDir, 'link-rollback');
    assert.equal((await fs.lstat(destPath)).isSymbolicLink(), true);
    assert.equal(await isSamePath(destPath, srcV1), true);

    if (process.platform === 'win32') {
      lockerProc = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `$fs = [System.IO.File]::Open($env:LOCK_TARGET, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); [Console]::Out.WriteLine('LOCKED'); [Console]::In.ReadLine() | Out-Null; $fs.Dispose()`,
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, LOCK_TARGET: v2LockedFile },
        },
      );

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for Windows source file lock')), 8000);
        let out = '';
        lockerProc.stdout.setEncoding('utf8');
        lockerProc.stdout.on('data', (chunk) => {
          out += chunk;
          if (out.includes('LOCKED')) {
            clearTimeout(timer);
            resolve();
          }
        });
        lockerProc.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Locker exited early with code ${code}`));
        });
      });

      await assert.rejects(() =>
        installPlugin({
          source: srcV2,
          sourceType: 'local',
          mode: 'copy',
          scope: 'global',
          overwrite: true,
          installRegistry: registry,
        }),
      );
    } else {
      await assert.rejects(() =>
        installPlugin({
          source: srcV2,
          sourceType: 'local',
          mode: 'copy',
          scope: 'global',
          overwrite: true,
          installRegistry: {
            record: async () => {
              throw new Error('Simulated registry failure');
            },
          },
        }),
      );
    }

    // Partial copy must be gone and original junction -> srcV1 restored; config.json untouched
    const restoredStat = await fs.lstat(destPath);
    assert.equal(restoredStat.isSymbolicLink(), true);
    assert.equal(await isSamePath(destPath, srcV1), true);
    const restoredManifest = JSON.parse(await fs.readFile(path.join(destPath, 'plugin.json'), 'utf8'));
    assert.equal(restoredManifest.version, '1.0.0');
    assert.equal(await fs.readFile(path.join(destPath, 'aaa-v1.txt'), 'utf8'), 'v1-intact');
    await assert.rejects(() => fs.lstat(path.join(destPath, 'aaa-first.txt')));
    assert.equal(await fs.readFile(configPath, 'utf8'), initialConfig);
  } finally {
    if (lockerProc) {
      const proc = lockerProc;
      lockerProc = null;
      await new Promise((resolve) => {
        const killTimer = setTimeout(() => {
          proc.kill();
          resolve();
        }, 2000);
        proc.once('close', () => {
          clearTimeout(killTimer);
          resolve();
        });
        proc.stdin.write('\n');
        proc.stdin.end();
      });
    }
    if (prevPluginsDir === undefined) delete process.env.ANTIGRAVITY_PLUGINS_DIR;
    else process.env.ANTIGRAVITY_PLUGINS_DIR = prevPluginsDir;
    if (prevConfigPath === undefined) delete process.env.ANTIGRAVITY_CONFIG_PATH;
    else process.env.ANTIGRAVITY_CONFIG_PATH = prevConfigPath;
    await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('R4: disabled plugin falls back to in-place sync when directory rename is blocked by watcher/EPERM', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-r4-inplace-ok-'));
  const prevPluginsDir = process.env.ANTIGRAVITY_PLUGINS_DIR;
  const prevConfigPath = process.env.ANTIGRAVITY_CONFIG_PATH;
  const watchers = [];

  try {
    const pluginsDir = path.join(sandbox, 'plugins');
    const configPath = path.join(sandbox, 'config.json');
    const srcV1 = path.join(sandbox, 'src-v1');
    const srcV2 = path.join(sandbox, 'src-v2');
    process.env.ANTIGRAVITY_PLUGINS_DIR = pluginsDir;
    process.env.ANTIGRAVITY_CONFIG_PATH = configPath;

    // v1 layout: includes subdir, obsolete file, obsolete watched dir, and file<->dir type flips
    await fs.mkdir(path.join(srcV1, 'sidecars', 'inspector'), { recursive: true });
    await fs.mkdir(path.join(srcV1, 'obsolete-dir'), { recursive: true });
    await fs.mkdir(path.join(srcV1, 'flip-dir-to-file'), { recursive: true });
    await fs.writeFile(
      path.join(srcV1, 'plugin.json'),
      JSON.stringify({ name: 'disabled-watch-demo', version: '1.0.0' }),
    );
    await fs.writeFile(path.join(srcV1, 'keep.txt'), 'v1-keep', 'utf8');
    await fs.writeFile(path.join(srcV1, 'obsolete-root.txt'), 'remove-me', 'utf8');
    await fs.writeFile(path.join(srcV1, 'sidecars', 'inspector', 'main.mjs'), 'console.log("v1");', 'utf8');
    await fs.writeFile(path.join(srcV1, 'obsolete-dir', 'old.txt'), 'old-nested', 'utf8');
    await fs.writeFile(path.join(srcV1, 'flip-dir-to-file', 'inside.txt'), 'was-dir', 'utf8');
    await fs.writeFile(path.join(srcV1, 'flip-file-to-dir'), 'was-file', 'utf8');

    // v2 layout
    await fs.mkdir(path.join(srcV2, 'sidecars', 'inspector'), { recursive: true });
    await fs.mkdir(path.join(srcV2, 'new-dir'), { recursive: true });
    await fs.mkdir(path.join(srcV2, 'flip-file-to-dir'), { recursive: true });
    await fs.writeFile(
      path.join(srcV2, 'plugin.json'),
      JSON.stringify({ name: 'disabled-watch-demo', version: '2.0.0' }),
    );
    await fs.writeFile(path.join(srcV2, 'keep.txt'), 'v2-keep', 'utf8');
    await fs.writeFile(path.join(srcV2, 'sidecars', 'inspector', 'main.mjs'), 'console.log("v2");', 'utf8');
    await fs.writeFile(path.join(srcV2, 'new-dir', 'added.txt'), 'brand-new', 'utf8');
    await fs.writeFile(path.join(srcV2, 'flip-dir-to-file'), 'now-file', 'utf8');
    await fs.writeFile(path.join(srcV2, 'flip-file-to-dir', 'child.txt'), 'now-dir-child', 'utf8');

    const initialConfig = JSON.stringify(
      { plugins: { 'disabled-watch-demo': { enabled: false } } },
      null,
      2,
    );
    await fs.writeFile(configPath, initialConfig, 'utf8');

    await installPlugin({ source: srcV1, scope: 'global' });
    const destPath = path.join(pluginsDir, 'disabled-watch-demo');

    // Simulate language_server.exe watching subdirectories on Windows, and fall back to simulated EPERM elsewhere
    let moveHook = null;
    if (process.platform === 'win32') {
      watchers.push(fsWatch(path.join(destPath, 'sidecars', 'inspector'), () => {}));
      watchers.push(fsWatch(path.join(destPath, 'obsolete-dir'), () => {}));
    } else {
      moveHook = async () => {
        const e = new Error('EPERM: simulated watcher lock on rename');
        e.code = 'EPERM';
        throw e;
      };
    }

    const res = await installPlugin({
      source: srcV2,
      scope: 'global',
      overwrite: true,
      removeRetries: 2,
      removeRetryDelayMs: 20,
      moveExistingToBackup: moveHook,
    });

    assert.equal(res.ok, true);
    assert.equal(res.overwrote, true);
    assert.equal(res.replacementMode, 'in-place');
    assert.equal(res.enabled, false);

    // Verify updated, added, flipped, and pruned files
    const manifest = JSON.parse(await fs.readFile(path.join(destPath, 'plugin.json'), 'utf8'));
    assert.equal(manifest.version, '2.0.0');
    assert.equal(await fs.readFile(path.join(destPath, 'keep.txt'), 'utf8'), 'v2-keep');
    assert.equal(
      await fs.readFile(path.join(destPath, 'sidecars', 'inspector', 'main.mjs'), 'utf8'),
      'console.log("v2");',
    );
    assert.equal(await fs.readFile(path.join(destPath, 'new-dir', 'added.txt'), 'utf8'), 'brand-new');
    assert.equal(await fs.readFile(path.join(destPath, 'flip-dir-to-file'), 'utf8'), 'now-file');
    assert.equal(
      await fs.readFile(path.join(destPath, 'flip-file-to-dir', 'child.txt'), 'utf8'),
      'now-dir-child',
    );
    await assert.rejects(() => fs.lstat(path.join(destPath, 'obsolete-root.txt')), { code: 'ENOENT' });
    await assert.rejects(() => fs.lstat(path.join(destPath, 'obsolete-dir', 'old.txt')), { code: 'ENOENT' });

    // config.json untouched and no sibling .backup directories left behind in pluginsDir
    assert.equal(await fs.readFile(configPath, 'utf8'), initialConfig);
    const rootEntries = await fs.readdir(pluginsDir);
    assert.deepEqual(rootEntries, ['disabled-watch-demo']);
  } finally {
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // Ignore
      }
    }
    if (prevPluginsDir === undefined) delete process.env.ANTIGRAVITY_PLUGINS_DIR;
    else process.env.ANTIGRAVITY_PLUGINS_DIR = prevPluginsDir;
    if (prevConfigPath === undefined) delete process.env.ANTIGRAVITY_CONFIG_PATH;
    else process.env.ANTIGRAVITY_CONFIG_PATH = prevConfigPath;
    await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('R4: disabled plugin in-place sync rolls back on genuinely locked file and reports locked=true + alreadyDisabled=true', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-r4-inplace-rollback-'));
  const prevPluginsDir = process.env.ANTIGRAVITY_PLUGINS_DIR;
  const prevConfigPath = process.env.ANTIGRAVITY_CONFIG_PATH;
  let lockerProc = null;

  const stopLocker = async () => {
    if (!lockerProc) return;
    const proc = lockerProc;
    lockerProc = null;
    await new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        proc.kill();
        resolve();
      }, 2000);
      proc.once('close', () => {
        clearTimeout(killTimer);
        resolve();
      });
      proc.stdin.write('\n');
      proc.stdin.end();
    });
  };

  try {
    const pluginsDir = path.join(sandbox, 'plugins');
    const configPath = path.join(sandbox, 'config.json');
    const srcV1 = path.join(sandbox, 'src-v1');
    const srcV2 = path.join(sandbox, 'src-v2');
    process.env.ANTIGRAVITY_PLUGINS_DIR = pluginsDir;
    process.env.ANTIGRAVITY_CONFIG_PATH = configPath;

    await fs.mkdir(srcV1, { recursive: true });
    await fs.writeFile(path.join(srcV1, 'aaa-first.txt'), 'v1-first', 'utf8');
    await fs.writeFile(
      path.join(srcV1, 'plugin.json'),
      JSON.stringify({ name: 'disabled-locked-file', version: '1.0.0' }),
    );
    await fs.writeFile(path.join(srcV1, 'zzz-locked.txt'), 'v1-locked', 'utf8');

    await fs.mkdir(srcV2, { recursive: true });
    await fs.writeFile(path.join(srcV2, 'aaa-first.txt'), 'v2-first', 'utf8');
    await fs.writeFile(path.join(srcV2, 'added-v2.txt'), 'should-be-rolled-back', 'utf8');
    await fs.writeFile(
      path.join(srcV2, 'plugin.json'),
      JSON.stringify({ name: 'disabled-locked-file', version: '2.0.0' }),
    );
    await fs.writeFile(path.join(srcV2, 'zzz-locked.txt'), 'v2-locked', 'utf8');

    const initialConfig = JSON.stringify(
      { plugins: { 'disabled-locked-file': { enabled: false } } },
      null,
      2,
    );
    await fs.writeFile(configPath, initialConfig, 'utf8');

    await installPlugin({ source: srcV1, scope: 'global' });
    const destPath = path.join(pluginsDir, 'disabled-locked-file');
    const lockedFile = path.join(destPath, 'zzz-locked.txt');

    if (process.platform === 'win32') {
      // Lock with FileShare.Read so backup copy succeeds, aaa-first.txt updates,
      // and then overwriting zzz-locked.txt fails mid-sync to exercise full rollback.
      lockerProc = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `$fs = [System.IO.File]::Open($env:LOCK_TARGET, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::Read); [Console]::Out.WriteLine('LOCKED'); [Console]::In.ReadLine() | Out-Null; $fs.Dispose()`,
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, LOCK_TARGET: lockedFile },
        },
      );

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for Windows file lock')), 8000);
        let out = '';
        lockerProc.stdout.setEncoding('utf8');
        lockerProc.stdout.on('data', (chunk) => {
          out += chunk;
          if (out.includes('LOCKED')) {
            clearTimeout(timer);
            resolve();
          }
        });
        lockerProc.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Locker exited early with code ${code}`));
        });
      });

      await assert.rejects(
        () =>
          installPlugin({
            source: srcV2,
            scope: 'global',
            overwrite: true,
            removeRetries: 1,
            removeRetryDelayMs: 20,
          }),
        (err) => {
          assert.equal(err.locked, true);
          assert.equal(err.alreadyDisabled, true);
          assert.match(err.message, /disabled plugin/i);
          assert.match(err.message, /files are locked/i);
          assert.match(err.message, /at "zzz-locked\.txt"/);
          assert.doesNotMatch(err.message, /Disable "disabled-locked-file"/);
          return true;
        },
      );

      // Verify full rollback of modified and newly added files while locked file stays v1
      assert.equal(await fs.readFile(path.join(destPath, 'aaa-first.txt'), 'utf8'), 'v1-first');
      const rolledBackManifest = JSON.parse(await fs.readFile(path.join(destPath, 'plugin.json'), 'utf8'));
      assert.equal(rolledBackManifest.version, '1.0.0');
      await assert.rejects(() => fs.lstat(path.join(destPath, 'added-v2.txt')), { code: 'ENOENT' });
      assert.equal(await fs.readFile(configPath, 'utf8'), initialConfig);
      await stopLocker();
      assert.equal(await fs.readFile(lockedFile, 'utf8'), 'v1-locked');
    } else {
      // Cross-platform fallback: verify post-sync failure rolls back and non-writable file reports alreadyDisabled
      await assert.rejects(
        () =>
          installPlugin({
            source: srcV2,
            scope: 'global',
            overwrite: true,
            removeRetries: 1,
            removeRetryDelayMs: 10,
            moveExistingToBackup: async () => {
              const e = new Error('EPERM: simulated rename lock');
              e.code = 'EPERM';
              throw e;
            },
            installRegistry: {
              record: async () => {
                const e = new Error('EBUSY: simulated post-sync lock');
                e.code = 'EBUSY';
                throw e;
              },
            },
          }),
        (err) => {
          assert.equal(err.locked, true);
          assert.equal(err.alreadyDisabled, true);
          return true;
        },
      );
      assert.equal(await fs.readFile(path.join(destPath, 'aaa-first.txt'), 'utf8'), 'v1-first');
      await assert.rejects(() => fs.lstat(path.join(destPath, 'added-v2.txt')), { code: 'ENOENT' });
    }
  } finally {
    await stopLocker();
    if (prevPluginsDir === undefined) delete process.env.ANTIGRAVITY_PLUGINS_DIR;
    else process.env.ANTIGRAVITY_PLUGINS_DIR = prevPluginsDir;
    if (prevConfigPath === undefined) delete process.env.ANTIGRAVITY_CONFIG_PATH;
    else process.env.ANTIGRAVITY_CONFIG_PATH = prevConfigPath;
    await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('R4: enabled plugin under directory lock still refuses with locked=true, alreadyDisabled=false, and customizationUri', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-r4-enabled-lock-'));
  const prevPluginsDir = process.env.ANTIGRAVITY_PLUGINS_DIR;
  const prevConfigPath = process.env.ANTIGRAVITY_CONFIG_PATH;
  let watcher = null;

  try {
    const pluginsDir = path.join(sandbox, 'plugins');
    const configPath = path.join(sandbox, 'config.json');
    const srcV1 = path.join(sandbox, 'src-v1');
    const srcV2 = path.join(sandbox, 'src-v2');
    process.env.ANTIGRAVITY_PLUGINS_DIR = pluginsDir;
    process.env.ANTIGRAVITY_CONFIG_PATH = configPath;

    await fs.mkdir(path.join(srcV1, 'sidecars', 'inspector'), { recursive: true });
    await fs.writeFile(
      path.join(srcV1, 'plugin.json'),
      JSON.stringify({ name: 'enabled-watch-demo', version: '1.0.0' }),
    );
    await fs.writeFile(path.join(srcV1, 'sidecars', 'inspector', 'main.mjs'), 'v1', 'utf8');

    await fs.mkdir(path.join(srcV2, 'sidecars', 'inspector'), { recursive: true });
    await fs.writeFile(
      path.join(srcV2, 'plugin.json'),
      JSON.stringify({ name: 'enabled-watch-demo', version: '2.0.0' }),
    );
    await fs.writeFile(path.join(srcV2, 'sidecars', 'inspector', 'main.mjs'), 'v2', 'utf8');

    const initialConfig = JSON.stringify(
      { plugins: { 'enabled-watch-demo': { enabled: true } } },
      null,
      2,
    );
    await fs.writeFile(configPath, initialConfig, 'utf8');

    await installPlugin({ source: srcV1, scope: 'global' });
    const destPath = path.join(pluginsDir, 'enabled-watch-demo');

    let moveHook = null;
    if (process.platform === 'win32') {
      watcher = fsWatch(path.join(destPath, 'sidecars', 'inspector'), () => {});
    } else {
      moveHook = async () => {
        const e = new Error('EPERM: simulated watcher lock');
        e.code = 'EPERM';
        throw e;
      };
    }

    await assert.rejects(
      () =>
        installPlugin({
          source: srcV2,
          scope: 'global',
          overwrite: true,
          removeRetries: 1,
          removeRetryDelayMs: 20,
          moveExistingToBackup: moveHook,
        }),
      (err) => {
        assert.equal(err.locked, true);
        assert.equal(err.alreadyDisabled, false);
        assert.equal(err.customizationUri, 'customization://enabled-watch-demo');
        assert.match(err.message, /Disable "enabled-watch-demo"/);
        return true;
      },
    );

    const manifest = JSON.parse(await fs.readFile(path.join(destPath, 'plugin.json'), 'utf8'));
    assert.equal(manifest.version, '1.0.0');
    assert.equal(await fs.readFile(configPath, 'utf8'), initialConfig);
  } finally {
    if (watcher) {
      try {
        watcher.close();
      } catch {
        // Ignore
      }
    }
    if (prevPluginsDir === undefined) delete process.env.ANTIGRAVITY_PLUGINS_DIR;
    else process.env.ANTIGRAVITY_PLUGINS_DIR = prevPluginsDir;
    if (prevConfigPath === undefined) delete process.env.ANTIGRAVITY_CONFIG_PATH;
    else process.env.ANTIGRAVITY_CONFIG_PATH = prevConfigPath;
    await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test(
  'R4: MCP stdio app_reinstall_plugin succeeds in-place on watched disabled plugin and forwards alreadyDisabled on hard file lock',
  { skip: process.platform !== 'win32' },
  async () => {
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-r4-mcp-lock-'));
    const pluginsDir = path.join(sandbox, 'plugins');
    const builtinDir = path.join(sandbox, 'builtin');
    const dataDir = path.join(sandbox, 'data');
    const configPath = path.join(sandbox, 'config.json');
    const srcDir = path.join(sandbox, 'src-plugin');
    let child = null;
    let watcher = null;
    let lockerProc = null;

    const stopLocker = async () => {
      if (!lockerProc) return;
      const proc = lockerProc;
      lockerProc = null;
      await new Promise((resolve) => {
        const killTimer = setTimeout(() => {
          proc.kill();
          resolve();
        }, 2000);
        proc.once('close', () => {
          clearTimeout(killTimer);
          resolve();
        });
        proc.stdin.write('\n');
        proc.stdin.end();
      });
    };

    try {
      await fs.mkdir(path.join(srcDir, 'sidecars', 'inspector'), { recursive: true });
      await fs.writeFile(
        path.join(srcDir, 'plugin.json'),
        JSON.stringify({ name: 'mcp-watch-demo', displayName: 'MCP Watch Demo', version: '1.0.0' }),
      );
      await fs.writeFile(path.join(srcDir, 'sidecars', 'inspector', 'main.mjs'), 'v1', 'utf8');
      await fs.writeFile(
        configPath,
        JSON.stringify({ plugins: { 'mcp-watch-demo': { enabled: false } } }, null, 2),
        'utf8',
      );

      child = spawn(process.execPath, [path.join(REPO_ROOT, 'server', 'index.mjs'), '--data-dir', dataDir], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ANTIGRAVITY_PLUGINS_DIR: pluginsDir,
          ANTIGRAVITY_BUILTIN_PLUGINS_DIR: builtinDir,
          ANTIGRAVITY_CONFIG_PATH: configPath,
        },
      });

      let stdoutBuf = '';
      const pending = new Map();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk;
        let idx;
        while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          const resolver = pending.get(msg.id);
          if (resolver) {
            pending.delete(msg.id);
            resolver(msg);
          }
        }
      });

      const rpc = (id, method, params = {}) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${method}`)), 12000);
          pending.set(id, (msg) => {
            clearTimeout(timer);
            resolve(msg);
          });
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        });

      await rpc(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });

      const inst = await rpc(2, 'tools/call', {
        name: 'app_install_plugin',
        arguments: { source: srcDir, scope: 'global' },
      });
      assert.equal(inst.result.structuredContent.ok, true);

      const destPath = path.join(pluginsDir, 'mcp-watch-demo');
      watcher = fsWatch(path.join(destPath, 'sidecars', 'inspector'), () => {});

      // 1. Disabled + watched subdir -> app_reinstall_plugin succeeds in-place
      await fs.writeFile(
        path.join(srcDir, 'plugin.json'),
        JSON.stringify({ name: 'mcp-watch-demo', displayName: 'MCP Watch Demo', version: '2.0.0' }),
      );
      await fs.writeFile(path.join(srcDir, 'sidecars', 'inspector', 'main.mjs'), 'v2', 'utf8');

      const updOk = await rpc(3, 'tools/call', {
        name: 'app_reinstall_plugin',
        arguments: { dir: 'mcp-watch-demo', scope: 'global' },
      });
      assert.equal(updOk.result.structuredContent.ok, true);
      assert.equal(updOk.result.structuredContent.install.replacementMode, 'in-place');
      assert.equal(updOk.result.structuredContent.install.plugin.version, '2.0.0');

      // 2. Disabled + genuinely locked file -> forwards locked=true, alreadyDisabled=true
      const lockedFile = path.join(destPath, 'sidecars', 'inspector', 'main.mjs');
      lockerProc = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `$fs = [System.IO.File]::Open($env:LOCK_TARGET, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::Read); [Console]::Out.WriteLine('LOCKED'); [Console]::In.ReadLine() | Out-Null; $fs.Dispose()`,
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, LOCK_TARGET: lockedFile },
        },
      );
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for lock')), 8000);
        let out = '';
        lockerProc.stdout.setEncoding('utf8');
        lockerProc.stdout.on('data', (chunk) => {
          out += chunk;
          if (out.includes('LOCKED')) {
            clearTimeout(timer);
            resolve();
          }
        });
        lockerProc.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Locker exited early with code ${code}`));
        });
      });

      const updFail = await rpc(4, 'tools/call', {
        name: 'app_reinstall_plugin',
        arguments: { dir: 'mcp-watch-demo', scope: 'global' },
      });
      assert.equal(updFail.result.structuredContent.ok, false);
      assert.equal(updFail.result.structuredContent.locked, true);
      assert.equal(updFail.result.structuredContent.alreadyDisabled, true);

      // 3. Enabled + watched subdir -> forwards locked=true, alreadyDisabled=false
      await stopLocker();
      await fs.writeFile(
        configPath,
        JSON.stringify({ plugins: { 'mcp-watch-demo': { enabled: true } } }, null, 2),
        'utf8',
      );
      const updEnabledLocked = await rpc(5, 'tools/call', {
        name: 'app_install_plugin',
        arguments: { source: srcDir, scope: 'global', overwrite: true },
      });
      assert.equal(updEnabledLocked.result.structuredContent.ok, false);
      assert.equal(updEnabledLocked.result.structuredContent.locked, true);
      assert.equal(updEnabledLocked.result.structuredContent.alreadyDisabled, false);
      assert.equal(updEnabledLocked.result.structuredContent.customizationUri, 'customization://mcp-watch-demo');
    } finally {
      await stopLocker();
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // Ignore
        }
      }
      if (child) {
        const exitPromise = new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once('close', resolve);
          setTimeout(resolve, 1000);
        });
        child.stdin.end();
        child.kill();
        await exitPromise;
      }
      await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
);
