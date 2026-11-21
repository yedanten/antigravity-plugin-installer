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

/**
 * Read-only inspection of ~/.gemini/config/config.json to display accurate
 * enabled/disabled badges. Never mutates config.json.
 */
async function readEnabledOverrides() {
  const configPath =
    process.env.ANTIGRAVITY_CONFIG_PATH ||
    path.join(os.homedir(), '.gemini', 'config', 'config.json');
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const json = parseJsonc(raw);
    if (json && typeof json.plugins === 'object' && json.plugins !== null) {
      return json.plugins;
    }
  } catch {
    // Missing or unreadable config.json is fine
  }
  return {};
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
    const override = overrides[entry.name];
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

export async function uninstallPlugin({ dir, scope = 'global', workspacePath = '', registry }) {
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
