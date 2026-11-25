import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Capture real host home BEFORE any test mutates process.env
export const REAL_HOME =
  process.env.USERPROFILE || process.env.HOME || os.homedir();

async function pathIsFile(candidate) {
  try {
    const st = await fs.stat(candidate);
    return st.isFile();
  } catch {
    return false;
  }
}

let cachedAgyBin;

/**
 * Resolve host agy(.exe) binary using AGY_BIN, PATH, or real host ~/.gemini/bin/agy.exe.
 */
export async function findAgyBin() {
  if (cachedAgyBin !== undefined) return cachedAgyBin;

  const candidates = [];
  if (process.env.AGY_BIN) {
    candidates.push(process.env.AGY_BIN);
  }

  const pathDirs = (process.env.PATH || '')
    .split(path.delimiter)
    .map((d) => d.trim())
    .filter(Boolean);
  const binNames = process.platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy'] : ['agy'];

  for (const dir of pathDirs) {
    for (const name of binNames) {
      candidates.push(path.join(dir, name));
    }
  }

  candidates.push(
    path.join(REAL_HOME, '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy'),
  );

  for (const candidate of candidates) {
    if (await pathIsFile(candidate)) {
      cachedAgyBin = candidate;
      return cachedAgyBin;
    }
  }

  cachedAgyBin = null;
  return null;
}

/**
 * Strip UTF-8 BOM + JSONC comments + trailing commas for reading sandbox config files in tests.
 */
export function parseJsoncLoose(raw) {
  const source = String(raw ?? '').replace(/^\uFEFF/, '');
  let out = '';
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }

  let cleaned = '';
  inString = false;
  escaped = false;
  for (let j = 0; j < out.length; j += 1) {
    const ch = out[j];
    if (inString) {
      cleaned += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      cleaned += ch;
      continue;
    }
    if (ch === ',') {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k])) k += 1;
      if (out[k] === '}' || out[k] === ']') continue;
    }
    cleaned += ch;
  }

  return JSON.parse(cleaned);
}

/**
 * Write a plugin directory fixture (source or pre-installed) with full v2.35.1 options.
 */
export async function writePluginFixture(targetDir, options = {}) {
  const {
    name = path.basename(targetDir),
    manifest,
    rawManifest,
    manifestSubdir = '',
    bom = false,
    jsoncComments = false,
    mcpConfig,
    mcpConfigBom = false,
    mcpConfigComments = false,
    dotMcpJson,
    hooks,
    nestedHooks,
    sidecars,
    skills = [],
    agents = [],
    rules = [],
    rootAgentsMd,
    logo,
    files = {},
  } = options;

  await fs.mkdir(targetDir, { recursive: true });

  if (rawManifest !== undefined) {
    const manifestDir = manifestSubdir ? path.join(targetDir, manifestSubdir) : targetDir;
    await fs.mkdir(manifestDir, { recursive: true });
    await fs.writeFile(
      path.join(manifestDir, 'plugin.json'),
      `${bom ? '\uFEFF' : ''}${rawManifest}`,
      'utf8',
    );
  } else if (manifest !== null) {
    const finalManifest =
      manifest === undefined
        ? {
            name,
            displayName: name,
            version: '1.0.0',
            description: `E2E fixture ${name}`,
          }
        : manifest;

    const manifestDir = manifestSubdir ? path.join(targetDir, manifestSubdir) : targetDir;
    await fs.mkdir(manifestDir, { recursive: true });

    let body = JSON.stringify(finalManifest, null, 2);
    if (jsoncComments) {
      body = `// JSONC comment\n${body.replace(/\}\s*$/, ',\n}')}\n`;
    }
    await fs.writeFile(
      path.join(manifestDir, 'plugin.json'),
      `${bom ? '\uFEFF' : ''}${body}`,
      'utf8',
    );
  }

  if (mcpConfig !== undefined) {
    let content =
      typeof mcpConfig === 'string' ? mcpConfig : JSON.stringify(mcpConfig, null, 2);
    if (mcpConfigComments && typeof mcpConfig !== 'string') {
      content = `// MCP JSONC comment\n${content.replace(/\}\s*$/, ',\n}')}\n`;
    }
    await fs.writeFile(
      path.join(targetDir, 'mcp_config.json'),
      `${mcpConfigBom ? '\uFEFF' : ''}${content}`,
      'utf8',
    );
  }

  if (dotMcpJson !== undefined) {
    const content =
      typeof dotMcpJson === 'string' ? dotMcpJson : JSON.stringify(dotMcpJson, null, 2);
    await fs.writeFile(path.join(targetDir, '.mcp.json'), content, 'utf8');
  }

  if (hooks !== undefined) {
    const content = typeof hooks === 'string' ? hooks : JSON.stringify(hooks, null, 2);
    await fs.writeFile(path.join(targetDir, 'hooks.json'), content, 'utf8');
  }

  if (nestedHooks !== undefined) {
    await fs.mkdir(path.join(targetDir, 'hooks'), { recursive: true });
    const content =
      typeof nestedHooks === 'string' ? nestedHooks : JSON.stringify(nestedHooks, null, 2);
    await fs.writeFile(path.join(targetDir, 'hooks', 'hooks.json'), content, 'utf8');
  }

  if (sidecars) {
    if (sidecars.json !== undefined) {
      const content =
        typeof sidecars.json === 'string'
          ? sidecars.json
          : JSON.stringify(sidecars.json, null, 2);
      await fs.writeFile(path.join(targetDir, 'sidecars.json'), content, 'utf8');
    }
    if (sidecars.dirs && typeof sidecars.dirs === 'object') {
      for (const [scName, scContent] of Object.entries(sidecars.dirs)) {
        const scDir = path.join(targetDir, 'sidecars', scName);
        await fs.mkdir(scDir, { recursive: true });
        if (scContent !== undefined && scContent !== null) {
          const text =
            typeof scContent === 'string' ? scContent : JSON.stringify(scContent, null, 2);
          await fs.writeFile(path.join(scDir, 'sidecar.json'), text, 'utf8');
        }
      }
    }
  }

  const skillEntries = Array.isArray(skills)
    ? skills.map((s) => [s, `---\nname: ${s}\ndescription: Skill ${s}\n---\n# ${s}\n`])
    : Object.entries(skills);
  for (const [skillName, skillBody] of skillEntries) {
    const skillDir = path.join(targetDir, 'skills', skillName);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillBody, 'utf8');
  }

  const agentEntries = Array.isArray(agents)
    ? agents.map((a) => [
        a,
        `---\nname: ${a}\ndescription: Agent ${a}\n---\n# Agent ${a}\n`,
      ])
    : Object.entries(agents);
  if (agentEntries.length > 0) {
    await fs.mkdir(path.join(targetDir, 'agents'), { recursive: true });
    for (const [agentName, agentBody] of agentEntries) {
      const fileName = agentName.endsWith('.md') ? agentName : `${agentName}.md`;
      await fs.writeFile(path.join(targetDir, 'agents', fileName), agentBody, 'utf8');
    }
  }

  const ruleEntries = Array.isArray(rules)
    ? rules.map((r) => [r, `# Rule ${r}\n`])
    : Object.entries(rules);
  if (ruleEntries.length > 0) {
    await fs.mkdir(path.join(targetDir, 'rules'), { recursive: true });
    for (const [ruleName, ruleBody] of ruleEntries) {
      const fileName = ruleName.endsWith('.md') ? ruleName : `${ruleName}.md`;
      await fs.writeFile(path.join(targetDir, 'rules', fileName), ruleBody, 'utf8');
    }
  }

  if (rootAgentsMd !== undefined) {
    await fs.writeFile(path.join(targetDir, 'AGENTS.md'), rootAgentsMd, 'utf8');
  }

  if (logo) {
    const logoPath = path.join(targetDir, logo.relPath || 'assets/logo.svg');
    await fs.mkdir(path.dirname(logoPath), { recursive: true });
    await fs.writeFile(
      logoPath,
      logo.content ?? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>',
      'utf8',
    );
  }

  for (const [rel, body] of Object.entries(files)) {
    const dest = path.join(targetDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, body);
  }

  return targetDir;
}

/**
 * Create an isolated temporary sandbox root under os.tmpdir().
 */
export async function createSandbox(prefix = 'agy-e2e-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const homeDir = path.join(root, 'home');
  const configDir = path.join(homeDir, '.gemini', 'config');
  const configPath = path.join(configDir, 'config.json');
  const globalPluginsDir = path.join(configDir, 'plugins');
  const appDataDir = path.join(homeDir, '.gemini', 'antigravity');
  const builtinPluginsDir = path.join(appDataDir, 'builtin', 'plugins');
  const workspaceDir = path.join(root, 'workspace');
  const workspacePluginsDir = path.join(workspaceDir, '.agents', 'plugins');
  const dataDir = path.join(root, 'data');
  const sourcesDir = path.join(root, 'sources');
  const tmpDir = path.join(root, 'tmp');

  await Promise.all([
    fs.mkdir(configDir, { recursive: true }),
    fs.mkdir(globalPluginsDir, { recursive: true }),
    fs.mkdir(builtinPluginsDir, { recursive: true }),
    fs.mkdir(workspacePluginsDir, { recursive: true }),
    fs.mkdir(dataDir, { recursive: true }),
    fs.mkdir(sourcesDir, { recursive: true }),
    fs.mkdir(tmpDir, { recursive: true }),
  ]);

  const trackedChildren = new Set();
  const cleanupHooks = [];

  function trackChild(child) {
    if (child) trackedChildren.add(child);
    return child;
  }

  function onCleanup(fn) {
    if (typeof fn === 'function') cleanupHooks.push(fn);
  }

  function env(overrides = {}, options = {}) {
    const out = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      ANTIGRAVITY_CONFIG_PATH: configPath,
      ANTIGRAVITY_APP_DATA_DIR: appDataDir,
      ANTIGRAVITY_PLUGINS_DIR: globalPluginsDir,
      ANTIGRAVITY_BUILTIN_PLUGINS_DIR: builtinPluginsDir,
      TMPDIR: tmpDir,
      TEMP: tmpDir,
      TMP: tmpDir,
    };

    if (options.omitConfigPath) delete out.ANTIGRAVITY_CONFIG_PATH;
    if (options.omitAppDataDir) delete out.ANTIGRAVITY_APP_DATA_DIR;
    if (options.omitPluginsDir) delete out.ANTIGRAVITY_PLUGINS_DIR;
    if (options.omitBuiltinPluginsDir) delete out.ANTIGRAVITY_BUILTIN_PLUGINS_DIR;

    for (const [key, val] of Object.entries(overrides)) {
      if (val === undefined || val === null) delete out[key];
      else out[key] = String(val);
    }
    return out;
  }

  async function createPluginSource(name, options = {}) {
    const dir = options.targetDir || path.join(sourcesDir, name);
    return writePluginFixture(dir, { name, ...options });
  }

  async function placeInstalledPlugin(scope, dirName, options = {}) {
    let baseDir = globalPluginsDir;
    if (scope === 'builtin') baseDir = builtinPluginsDir;
    else if (scope === 'workspace') baseDir = workspacePluginsDir;
    const dest = path.join(baseDir, dirName);
    return writePluginFixture(dest, { name: dirName, ...options });
  }

  async function writeConfig(data, { bom = false, targetPath = configPath } = {}) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const raw = typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`;
    await fs.writeFile(targetPath, `${bom ? '\uFEFF' : ''}${raw}`, 'utf8');
    return targetPath;
  }

  async function readConfig(targetPath = configPath) {
    const raw = await fs.readFile(targetPath, 'utf8');
    return parseJsoncLoose(raw);
  }

  async function readConfigRaw(targetPath = configPath) {
    return fs.readFile(targetPath, 'utf8');
  }

  async function readInstallRegistry() {
    const raw = await fs.readFile(path.join(dataDir, 'install-registry.json'), 'utf8');
    return JSON.parse(raw);
  }

  async function stageSandboxedSelfCopy({
    dirName = 'plugin-installer',
    enabled = true,
  } = {}) {
    const pluginDir = path.join(globalPluginsDir, dirName);
    await fs.mkdir(pluginDir, { recursive: true });

    const copyEntries = [
      'package.json',
      'plugin.json',
      'mcp_config.json',
      'server',
      'assets',
      'skills',
    ];

    for (const entry of copyEntries) {
      const src = path.join(REPO_ROOT, entry);
      const dst = path.join(pluginDir, entry);
      await fs.cp(src, dst, { recursive: true });
    }

    if (enabled === false || enabled === true) {
      let existing = {};
      try {
        existing = await readConfig();
      } catch {
        existing = {};
      }
      await writeConfig({
        ...existing,
        plugins: {
          ...(existing.plugins || {}),
          [dirName]: {
            ...(existing.plugins?.[dirName] || {}),
            enabled,
          },
        },
      });
    }

    return {
      dirName,
      pluginDir,
      serverEntry: path.join(pluginDir, 'server', 'index.mjs'),
    };
  }

  async function runAgy(args, { cwd = root, envOverrides = {}, envOptions = {}, timeoutMs = 20000 } = {}) {
    const agyBin = await findAgyBin();
    if (!agyBin) {
      throw new Error('Host agy(.exe) binary not found for E2E CLI execution.');
    }
    try {
      const { stdout, stderr } = await execFileAsync(agyBin, args, {
        cwd,
        env: env(envOverrides, envOptions),
        timeout: timeoutMs,
        windowsHide: true,
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      return {
        code: typeof err?.code === 'number' ? err.code : 1,
        stdout: err?.stdout || '',
        stderr: err?.stderr || err?.message || '',
      };
    }
  }

  async function cleanup() {
    for (const hook of cleanupHooks.splice(0).reverse()) {
      try {
        await hook();
      } catch {
        // Best-effort teardown hook
      }
    }

    for (const child of trackedChildren) {
      try {
        if (child && !child.killed && child.exitCode === null) {
          child.kill('SIGKILL');
        }
      } catch {
        // Ignore already exited
      }
    }
    trackedChildren.clear();

    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 120,
    });
  }

  return {
    root,
    homeDir,
    configDir,
    configPath,
    globalPluginsDir,
    appDataDir,
    builtinPluginsDir,
    workspaceDir,
    workspacePluginsDir,
    dataDir,
    sourcesDir,
    tmpDir,
    env,
    createPluginSource,
    placeInstalledPlugin,
    writeConfig,
    readConfig,
    readConfigRaw,
    readInstallRegistry,
    stageSandboxedSelfCopy,
    runAgy,
    findAgyBin,
    trackChild,
    onCleanup,
    cleanup,
  };
}
