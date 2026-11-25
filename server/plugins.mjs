import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseJsonc, validatePluginDir } from './validator.mjs';

const MAX_LOGO_BYTES = 256 * 1024;
const MIME_BY_EXT = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

let configWriteQueue = Promise.resolve();

function runSerializedConfigWrite(task) {
  const next = configWriteQueue.then(task, task);
  configWriteQueue = next.catch(() => {});
  return next;
}

export function getGlobalPluginsDir() {
  if (process.env.ANTIGRAVITY_PLUGINS_DIR) {
    return path.resolve(process.env.ANTIGRAVITY_PLUGINS_DIR);
  }
  return path.join(os.homedir(), '.gemini', 'config', 'plugins');
}

export function getBuiltinPluginsDir() {
  if (process.env.ANTIGRAVITY_BUILTIN_PLUGINS_DIR) {
    return path.resolve(process.env.ANTIGRAVITY_BUILTIN_PLUGINS_DIR);
  }
  if (process.env.ANTIGRAVITY_APP_DATA_DIR) {
    return path.join(path.resolve(process.env.ANTIGRAVITY_APP_DATA_DIR), 'builtin', 'plugins');
  }
  return path.join(os.homedir(), '.gemini', 'antigravity', 'builtin', 'plugins');
}

export function getWorkspacePluginsDir(workspacePath) {
  if (!workspacePath || !String(workspacePath).trim()) return null;
  const resolved = expandHomePath(String(workspacePath).trim());
  return path.join(resolved, '.agents', 'plugins');
}

export function expandHomePath(rawPath) {
  let cleaned = String(rawPath || '').trim();
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  if (cleaned === '~') return os.homedir();
  if (cleaned.startsWith('~/') || cleaned.startsWith('~\\')) {
    return path.join(os.homedir(), cleaned.slice(2));
  }
  return path.resolve(cleaned);
}

async function isExecutableFile(candidate) {
  try {
    const st = await fs.stat(candidate);
    if (!st.isFile()) return false;
    if (process.platform !== 'win32') {
      await fs.access(candidate, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export async function resolveAgyPath() {
  const pathEnv = process.env.PATH || '';
  const pathDirs = pathEnv
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean);

  const binNames = process.platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy'] : ['agy'];

  for (const dir of pathDirs) {
    for (const binName of binNames) {
      const candidate = path.join(dir, binName);
      if (await isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  const fallbackBin = process.platform === 'win32' ? 'agy.exe' : 'agy';
  const homeCandidate = path.join(os.homedir(), '.gemini', 'bin', fallbackBin);
  if (await isExecutableFile(homeCandidate)) {
    return homeCandidate;
  }

  return null;
}

export function getConfigPath() {
  if (process.env.ANTIGRAVITY_CONFIG_PATH) {
    return path.resolve(process.env.ANTIGRAVITY_CONFIG_PATH);
  }
  return path.join(os.homedir(), '.gemini', 'config', 'config.json');
}

export async function readAntigravityConfig() {
  const configPath = getConfigPath();
  let raw;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {};
    }
    throw err;
  }

  if (!raw.trim()) {
    return {};
  }

  const parsed = parseJsonc(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid Antigravity config at ${configPath}: expected a JSON object.`);
  }
  return parsed;
}

/**
 * Inspect ~/.gemini/config/config.json to read plugin enablement overrides.
 */
export async function readEnabledOverrides() {
  try {
    const json = await readAntigravityConfig();
    if (json && typeof json.plugins === 'object' && json.plugins !== null && !Array.isArray(json.plugins)) {
      return json.plugins;
    }
  } catch {
    // Missing or unreadable config.json falls back to manifest defaults
  }
  return {};
}

export async function isSamePath(a, b) {
  if (!a || !b) return false;
  const resolveReal = async (targetPath) => {
    const resolved = path.resolve(targetPath);
    try {
      return await fs.realpath(resolved);
    } catch {
      return resolved;
    }
  };
  const [realA, realB] = await Promise.all([resolveReal(a), resolveReal(b)]);
  if (process.platform === 'win32') {
    return realA.toLowerCase() === realB.toLowerCase();
  }
  return realA === realB;
}

export function validatePluginDirName(dirName) {
  if (
    !dirName ||
    typeof dirName !== 'string' ||
    dirName.trim() !== dirName ||
    dirName === '.' ||
    dirName === '..' ||
    dirName.includes('/') ||
    dirName.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(dirName) ||
    dirName === '__proto__' ||
    dirName === 'constructor' ||
    dirName === 'prototype'
  ) {
    throw new Error(`Invalid plugin directory name: "${String(dirName)}"`);
  }
}

export async function setPluginEnabled(dirName, enabled) {
  validatePluginDirName(dirName);
  const nextEnabled = Boolean(enabled);

  return runSerializedConfigWrite(async () => {
    const configPath = getConfigPath();
    const config = await readAntigravityConfig();

    const existingPlugins =
      config.plugins && typeof config.plugins === 'object' && !Array.isArray(config.plugins)
        ? { ...config.plugins }
        : {};

    const previousEntry =
      Object.hasOwn(existingPlugins, dirName) &&
      existingPlugins[dirName] &&
      typeof existingPlugins[dirName] === 'object' &&
      !Array.isArray(existingPlugins[dirName])
        ? { ...existingPlugins[dirName] }
        : {};

    const previousEnabled =
      typeof previousEntry.enabled === 'boolean' ? previousEntry.enabled : undefined;

    existingPlugins[dirName] = {
      ...previousEntry,
      enabled: nextEnabled,
    };

    const nextConfig = {
      ...config,
      plugins: existingPlugins,
    };

    const configDir = path.dirname(configPath);
    await fs.mkdir(configDir, { recursive: true });
    const tmpPath = path.join(
      configDir,
      `.${path.basename(configPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );

    try {
      await fs.writeFile(tmpPath, `${JSON.stringify(nextConfig, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      if (process.platform !== 'win32') {
        await fs.chmod(tmpPath, 0o600).catch(() => {});
      }
      await fs.rename(tmpPath, configPath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }

    return {
      dir: dirName,
      enabled: nextEnabled,
      previousEnabled,
      configPath,
    };
  });
}

export class InstallRegistry {
  constructor(dataDir) {
    this.dataDir = dataDir ? path.resolve(dataDir) : path.join(os.homedir(), '.gemini', 'antigravity', 'plugin-installer-data');
    this.filePath = path.join(this.dataDir, 'install-registry.json');
  }

  async readAll() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && typeof parsed.entries === 'object') {
        return parsed.entries;
      }
    } catch {
      // File may not exist yet
    }
    return {};
  }

  async record(key, metadata) {
    await fs.mkdir(this.dataDir, { recursive: true });
    const entries = await this.readAll();
    entries[key] = {
      ...metadata,
      updatedAt: new Date().toISOString(),
    };
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(
      tmpPath,
      JSON.stringify({ version: 1, entries }, null, 2),
      'utf8',
    );
    await fs.rename(tmpPath, this.filePath);
  }

  async remove(key) {
    const entries = await this.readAll();
    if (!(key in entries)) return;
    delete entries[key];
    await fs.mkdir(this.dataDir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(
      tmpPath,
      JSON.stringify({ version: 1, entries }, null, 2),
      'utf8',
    );
    await fs.rename(tmpPath, this.filePath);
  }
}

export function registryKey(scope, dir, workspacePath) {
  if (scope === 'workspace' && workspacePath) {
    return `workspace:${path.resolve(workspacePath)}:${dir}`;
  }
  return `global:${dir}`;
}

async function readLogoDataUri(pluginDir, logoRelPath) {
  if (!logoRelPath || typeof logoRelPath !== 'string') return null;
  const resolvedBase = path.resolve(pluginDir);
  const resolvedLogo = path.resolve(resolvedBase, logoRelPath);
  if (!resolvedLogo.startsWith(resolvedBase + path.sep)) return null;

  const ext = path.extname(resolvedLogo).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) return null;

  try {
    const stat = await fs.stat(resolvedLogo);
    if (!stat.isFile() || stat.size > MAX_LOGO_BYTES) return null;
    const buf = await fs.readFile(resolvedLogo);
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

async function scanPluginsRoot(rootDir, scope, overrides, registryEntries, workspacePath) {
  const results = [];
  let dirEntries;
  try {
    dirEntries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of dirEntries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(rootDir, entry.name);

    let lstat;
    let stat;
    try {
      lstat = await fs.lstat(fullPath);
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }

    if (!stat.isDirectory()) continue;

    const isSymlink = lstat.isSymbolicLink();
    let linkTarget = null;
    if (isSymlink) {
      try {
        linkTarget = await fs.realpath(fullPath);
      } catch {
        linkTarget = null;
      }
    }

    const validation = await validatePluginDir(fullPath, { strict: false });
    const manifest = validation.manifest || {};
    const override = Object.hasOwn(overrides, entry.name) ? overrides[entry.name] : undefined;
    const enabled =
      override && typeof override.enabled === 'boolean'
        ? override.enabled
        : manifest.disabled !== true;

    const key = registryKey(scope, entry.name, workspacePath);
    const installMeta = registryEntries[key] || null;
    const logoDataUri = manifest.logo ? await readLogoDataUri(fullPath, manifest.logo) : null;

    const author =
      typeof manifest.author === 'string'
        ? manifest.author
        : manifest.author && typeof manifest.author === 'object'
          ? manifest.author.name || ''
          : '';

    results.push({
      id: `${scope}:${entry.name}`,
      dir: entry.name,
      name: manifest.name || entry.name,
      displayName: manifest.displayName || manifest.name || entry.name,
      description: manifest.description || '',
      version: manifest.version || '',
      author,
      homepage: manifest.homepage || '',
      repository:
        typeof manifest.repository === 'string'
          ? manifest.repository
          : manifest.repository?.url || '',
      scope,
      path: fullPath,
      enabled,
      isBuiltin: scope === 'builtin',
      isSymlink,
      linkTarget,
      logoDataUri,
      valid: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings,
      components: validation.components,
      installMeta,
      canUninstall: scope !== 'builtin',
      canReinstall: scope !== 'builtin' && Boolean(installMeta?.rawSource),
    });
  }

  return results;
}

export async function listInstalledPlugins({ registry, workspacePath = '' } = {}) {
  const globalDir = getGlobalPluginsDir();
  const builtinDir = getBuiltinPluginsDir();
  const workspaceDir = getWorkspacePluginsDir(workspacePath);

  const [overrides, registryEntries] = await Promise.all([
    readEnabledOverrides(),
    registry ? registry.readAll() : Promise.resolve({}),
  ]);

  const scans = [
    scanPluginsRoot(globalDir, 'global', overrides, registryEntries, ''),
    scanPluginsRoot(builtinDir, 'builtin', overrides, registryEntries, ''),
  ];
  if (workspaceDir) {
    scans.push(scanPluginsRoot(workspaceDir, 'workspace', overrides, registryEntries, workspacePath));
  }

  const [globalPlugins, builtinPlugins, workspacePlugins = []] = await Promise.all(scans);

  const plugins = [...workspacePlugins, ...globalPlugins, ...builtinPlugins].sort((a, b) => {
    if (a.isBuiltin !== b.isBuiltin) return a.isBuiltin ? 1 : -1;
    return a.displayName.localeCompare(b.displayName);
  });

  return {
    plugins,
    paths: {
      globalDir,
      builtinDir,
      workspaceDir,
    },
    counts: {
      total: plugins.length,
      global: globalPlugins.length,
      workspace: workspacePlugins.length,
      builtin: builtinPlugins.length,
    },
  };
}

export async function uninstallPlugin({ dir, scope = 'global', workspacePath = '', registry, pluginRoot = '' }) {
  if (!dir || typeof dir !== 'string' || dir.includes('/') || dir.includes('\\') || dir === '.' || dir === '..') {
    throw new Error('Invalid plugin directory name.');
  }

  if (scope === 'builtin') {
    throw new Error('Built-in plugins cannot be uninstalled.');
  }

  const rootDir =
    scope === 'workspace' ? getWorkspacePluginsDir(workspacePath) : getGlobalPluginsDir();
  if (!rootDir) {
    throw new Error('Workspace path is required to uninstall a workspace plugin.');
  }

  const resolvedRoot = path.resolve(rootDir);
  const targetPath = path.resolve(resolvedRoot, dir);
  if (!targetPath.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Security violation: target path escapes plugins directory.');
  }

  let lstat;
  try {
    lstat = await fs.lstat(targetPath);
  } catch {
    throw new Error(`Plugin "${dir}" not found at ${targetPath}.`);
  }

  if (pluginRoot && (await isSamePath(targetPath, pluginRoot))) {
    const selfErr = new Error(
      'Cannot uninstall Plugin Installer from its own panel because doing so would delete its running MCP server and UI.',
    );
    selfErr.code = 'SELF_UNINSTALL_BLOCKED';
    throw selfErr;
  }

  if (lstat.isSymbolicLink()) {
    await fs.unlink(targetPath);
  } else {
    await fs.rm(targetPath, { recursive: true, force: true });
  }

  if (registry) {
    await registry.remove(registryKey(scope, dir, workspacePath));
  }

  return {
    ok: true,
    dir,
    scope,
    removedPath: targetPath,
    wasSymlink: lstat.isSymbolicLink(),
  };
}
