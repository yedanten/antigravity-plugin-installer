import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
  listInstalledPlugins,
  uninstallPlugin,
} from '../server/plugins.mjs';
import { parseJsonc, validatePluginDir } from '../server/validator.mjs';

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
  const result = await validatePluginDir(REPO_ROOT, { strict: true });
  assert.equal(result.valid, true, `Validation errors: ${result.errors.join('; ')}`);
  assert.equal(result.manifest.name, 'plugin-installer');
  assert.deepEqual(result.components.skills, ['install-plugin']);
  assert.deepEqual(result.components.mcpServers, ['installer']);
});

test('parseJsonc preserves URLs inside strings while stripping comments and trailing commas', () => {
  const raw = `{
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
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('local plugin install (copy & link), overwrite guard, list, and safe uninstall', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-install-sandbox-'));
  const prevPluginsDir = process.env.ANTIGRAVITY_PLUGINS_DIR;
  const prevBuiltinDir = process.env.ANTIGRAVITY_BUILTIN_PLUGINS_DIR;

  try {
    const pluginsDir = path.join(sandbox, 'global-plugins');
    const builtinDir = path.join(sandbox, 'builtin-plugins');
    const dataDir = path.join(sandbox, 'installer-data');
    const srcPlugin = path.join(sandbox, 'sample-src');

    process.env.ANTIGRAVITY_PLUGINS_DIR = pluginsDir;
    process.env.ANTIGRAVITY_BUILTIN_PLUGINS_DIR = builtinDir;

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
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test('MCP stdio server responds to initialize, tools/list, resources/read, and tools/call', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-mcp-test-'));
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'server', 'index.mjs'), '--data-dir', sandbox], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ANTIGRAVITY_PLUGINS_DIR: path.join(sandbox, 'plugins'),
      ANTIGRAVITY_BUILTIN_PLUGINS_DIR: path.join(sandbox, 'builtin'),
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
    child.stdin.end();
    child.kill();
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});
