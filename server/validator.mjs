import fs from 'node:fs/promises';
import path from 'node:path';

export const ALLOWED_MANIFEST_KEYS = new Set([
  '$schema',
  'name',
  'displayName',
  'description',
  'version',
  'disabled',
  'logo',
  'suggestedPrompts',
  'skills',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'category',
  'extensions',
]);

const VALID_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VALID_LOGO_EXTS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp']);

/**
 * Parse JSON with comments (JSONC) and trailing commas safely without
 * corrupting string literals (such as https:// URLs).
 * Strips a leading UTF-8 BOM (\uFEFF) if present.
 */
export function parseJsonc(raw) {
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
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
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
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        i += 1;
      }
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  // Strip trailing commas outside of strings
  let cleaned = '';
  inString = false;
  escaped = false;
  for (let j = 0; j < out.length; j += 1) {
    const ch = out[j];
    if (inString) {
      cleaned += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
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
      if (out[k] === '}' || out[k] === ']') {
        continue;
      }
    }
    cleaned += ch;
  }

  return JSON.parse(cleaned);
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(p) {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

export async function findManifestPath(pluginDir) {
  const candidates = [
    path.join(pluginDir, '.antigravity-plugin', 'plugin.json'),
    path.join(pluginDir, '.gemini-plugin', 'plugin.json'),
    path.join(pluginDir, 'plugin.json'),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function sanitizePluginDirName(raw) {
  const normalized = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[\/\\]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'custom-plugin';
}

async function collectSkills(pluginDir, manifestSkills) {
  const skillNames = [];
  const roots = [path.join(pluginDir, 'skills')];

  if (typeof manifestSkills === 'string' && manifestSkills.trim()) {
    roots.push(path.resolve(pluginDir, manifestSkills));
  } else if (Array.isArray(manifestSkills)) {
    for (const item of manifestSkills) {
      if (typeof item === 'string' && item.trim()) {
        roots.push(path.resolve(pluginDir, item));
      }
    }
  }

  const seen = new Set();
  const resolvedBase = path.resolve(pluginDir);

  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    if (!resolvedRoot.startsWith(resolvedBase)) continue;
    if (!(await isDirectory(resolvedRoot))) continue;

    const entries = await fs.readdir(resolvedRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillFile = path.join(resolvedRoot, entry.name, 'SKILL.md');
      if (await exists(skillFile)) {
        if (!seen.has(entry.name)) {
          seen.add(entry.name);
          skillNames.push(entry.name);
        }
      }
    }
  }
  return skillNames;
}

async function collectMarkdownItems(dirPath) {
  if (!(await isDirectory(dirPath))) return [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => e.name.replace(/\.md$/i, ''));
}

async function collectSidecars(pluginDir, errors) {
  const names = new Set();

  const sidecarsJsonPath = path.join(pluginDir, 'sidecars.json');
  if (await exists(sidecarsJsonPath)) {
    try {
      const raw = await fs.readFile(sidecarsJsonPath, 'utf8');
      const parsed = parseJsonc(raw);
      if (Array.isArray(parsed)) {
        parsed.forEach((item, idx) => {
          const name = item && typeof item === 'object' ? (item.name || item.id) : item;
          names.add(String(name || `sidecar-${idx + 1}`));
        });
      } else if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.sidecars)) {
          parsed.sidecars.forEach((item, idx) => {
            const name = item && typeof item === 'object' ? (item.name || item.id) : item;
            names.add(String(name || `sidecar-${idx + 1}`));
          });
        } else if (parsed.sidecars && typeof parsed.sidecars === 'object') {
          for (const key of Object.keys(parsed.sidecars)) {
            names.add(key);
          }
        } else {
          for (const key of Object.keys(parsed)) {
            names.add(key);
          }
        }
      }
    } catch (err) {
      errors.push(`Invalid sidecars.json: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const sidecarsDir = path.join(pluginDir, 'sidecars');
  if (await isDirectory(sidecarsDir)) {
    const entries = await fs.readdir(sidecarsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const sidecarManifestPath = path.join(sidecarsDir, entry.name, 'sidecar.json');
      if (await exists(sidecarManifestPath)) {
        try {
          const raw = await fs.readFile(sidecarManifestPath, 'utf8');
          parseJsonc(raw);
        } catch (err) {
          errors.push(
            `Invalid sidecars/${entry.name}/sidecar.json: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      names.add(entry.name);
    }
  }

  return Array.from(names);
}

export async function validatePluginDir(pluginDir, { strict = false } = {}) {
  const errors = [];
  const warnings = [];
  const resolvedDir = path.resolve(pluginDir);
  const emptyComponents = { skills: [], mcpServers: [], agents: [], rules: [], hasHooks: false, sidecars: [] };

  const addWarning = (msg) => {
    if (strict) errors.push(msg);
    else warnings.push(msg);
  };

  if (!(await isDirectory(resolvedDir))) {
    return {
      valid: false,
      errors: [`Plugin path is not an existing directory: ${resolvedDir}`],
      warnings,
      manifest: null,
      manifestPath: null,
      components: emptyComponents,
    };
  }

  const manifestPath = await findManifestPath(resolvedDir);
  if (!manifestPath) {
    const hasClaude = await exists(path.join(resolvedDir, '.claude-plugin', 'plugin.json'));
    const hasGemini = await exists(path.join(resolvedDir, 'gemini-extension.json'));
    let hint = 'Expected plugin.json (or .antigravity-plugin/plugin.json, .gemini-plugin/plugin.json) in the plugin root.';
    if (hasClaude || hasGemini) {
      hint += ' Detected a Claude Code or Gemini CLI extension; convert or add a plugin.json manifest first.';
    }
    return {
      valid: false,
      errors: [`Missing plugin.json manifest. ${hint}`],
      warnings,
      manifest: null,
      manifestPath: null,
      components: emptyComponents,
    };
  }

  let manifest;
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    manifest = parseJsonc(raw);
  } catch (err) {
    return {
      valid: false,
      errors: [`Invalid JSON in ${path.basename(manifestPath)}: ${err instanceof Error ? err.message : String(err)}`],
      warnings,
      manifest: null,
      manifestPath,
      components: emptyComponents,
    };
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return {
      valid: false,
      errors: ['plugin.json must contain a JSON object.'],
      warnings,
      manifest: null,
      manifestPath,
      components: emptyComponents,
    };
  }

  // Check unknown top-level fields
  for (const key of Object.keys(manifest)) {
    if (!ALLOWED_MANIFEST_KEYS.has(key)) {
      addWarning(`Unknown top-level field "${key}" in plugin.json (silently discarded by Antigravity).`);
    }
  }

  // Warn (error in strict mode) on misplaced rule/config files at root
  for (const ruleFile of ['AGENTS.md', 'GEMINI.md', 'CLAUDE.md']) {
    if (await exists(path.join(resolvedDir, ruleFile))) {
      addWarning(
        `Misplaced "${ruleFile}" at plugin root (plugins load rules only from rules/; move it to rules/${ruleFile}).`,
      );
    }
  }
  if (await exists(path.join(resolvedDir, 'hooks', 'hooks.json'))) {
    addWarning('Misplaced "hooks/hooks.json" (native Antigravity plugins load hooks only from root hooks.json).');
  }
  if (await exists(path.join(resolvedDir, '.mcp.json'))) {
    addWarning('Misplaced ".mcp.json" (native Antigravity plugins use mcp_config.json at the plugin root).');
  }

  // Validate name
  if (manifest.name !== undefined) {
    if (typeof manifest.name !== 'string' || !VALID_NAME_RE.test(manifest.name)) {
      errors.push('Field "name" must be lowercase kebab-case matching ^[a-z0-9]+(-[a-z0-9]+)*$.');
    }
  } else if (strict) {
    errors.push('Field "name" is required in strict mode.');
  } else {
    warnings.push('Field "name" is omitted; Antigravity will fall back to the directory name.');
  }

  // Validate optional logo
  if (manifest.logo !== undefined) {
    if (typeof manifest.logo !== 'string' || !manifest.logo.trim()) {
      errors.push('Field "logo" must be a non-empty relative path string.');
    } else if (/^https?:\/\//i.test(manifest.logo) || path.isAbsolute(manifest.logo)) {
      errors.push('Field "logo" must be a relative path inside the plugin directory, not a URL or absolute path.');
    } else {
      const ext = path.extname(manifest.logo).toLowerCase();
      if (!VALID_LOGO_EXTS.has(ext)) {
        errors.push(`Unsupported logo extension "${ext}". Allowed: .svg, .png, .jpg, .jpeg, .webp.`);
      }
      const resolvedLogo = path.resolve(resolvedDir, manifest.logo);
      if (!resolvedLogo.startsWith(resolvedDir + path.sep) && resolvedLogo !== resolvedDir) {
        errors.push('Field "logo" cannot escape the plugin directory.');
      } else if (!(await exists(resolvedLogo))) {
        errors.push(`Logo file not found at "${manifest.logo}".`);
      }
    }
  }

  // Validate suggestedPrompts
  if (manifest.suggestedPrompts !== undefined) {
    if (!Array.isArray(manifest.suggestedPrompts)) {
      errors.push('Field "suggestedPrompts" must be an array of strings.');
    } else {
      if (manifest.suggestedPrompts.length > 3) {
        warnings.push('More than 3 suggestedPrompts declared; Antigravity ignores prompts beyond 3.');
      }
      for (const prompt of manifest.suggestedPrompts) {
        if (typeof prompt !== 'string' || !prompt.trim()) {
          errors.push('Every entry in "suggestedPrompts" must be a non-empty string.');
          break;
        }
      }
    }
  }

  // Validate homepage / repository URLs if present
  if (manifest.homepage !== undefined) {
    if (typeof manifest.homepage !== 'string' || !manifest.homepage.startsWith('https://')) {
      errors.push('Field "homepage" must be an https:// URL.');
    }
  }
  if (manifest.repository !== undefined) {
    const repoUrl =
      typeof manifest.repository === 'string'
        ? manifest.repository
        : manifest.repository && typeof manifest.repository === 'object'
          ? manifest.repository.url
          : null;
    if (typeof repoUrl !== 'string' || !repoUrl.startsWith('https://')) {
      errors.push('Field "repository" must be an https:// URL string (or object with https:// url).');
    }
  }

  // Inspect components
  const skills = await collectSkills(resolvedDir, manifest.skills);
  const agents = await collectMarkdownItems(path.join(resolvedDir, 'agents'));
  const rules = await collectMarkdownItems(path.join(resolvedDir, 'rules'));
  const sidecars = await collectSidecars(resolvedDir, errors);

  const mcpServers = [];
  const mcpConfigPath = path.join(resolvedDir, 'mcp_config.json');
  if (await exists(mcpConfigPath)) {
    try {
      const mcpRaw = await fs.readFile(mcpConfigPath, 'utf8');
      const mcpJson = parseJsonc(mcpRaw);
      if (!mcpJson || typeof mcpJson !== 'object' || !mcpJson.mcpServers || typeof mcpJson.mcpServers !== 'object' || Array.isArray(mcpJson.mcpServers)) {
        errors.push('mcp_config.json must contain a top-level "mcpServers" object.');
      } else {
        for (const [serverName, cfg] of Object.entries(mcpJson.mcpServers)) {
          mcpServers.push(serverName);
          if (!cfg || typeof cfg !== 'object') {
            errors.push(`MCP server "${serverName}" in mcp_config.json must be an object.`);
            continue;
          }
          const hasHttp = Boolean(cfg.url || cfg.serverUrl);
          const hasStdio = Boolean(cfg.command || cfg.args !== undefined || cfg.env !== undefined);
          if (hasHttp && hasStdio) {
            errors.push(
              `MCP server "${serverName}" in mcp_config.json cannot specify both "url"/"serverUrl" and "command"/"args"/"env".`,
            );
          } else if (!cfg.command && !cfg.url && !cfg.serverUrl) {
            errors.push(`MCP server "${serverName}" in mcp_config.json must define "command" or "url".`);
          }
        }
      }
    } catch (err) {
      errors.push(`Invalid mcp_config.json: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let hasHooks = false;
  const hooksPath = path.join(resolvedDir, 'hooks.json');
  if (await exists(hooksPath)) {
    try {
      const hooksRaw = await fs.readFile(hooksPath, 'utf8');
      parseJsonc(hooksRaw);
      hasHooks = true;
    } catch (err) {
      errors.push(`Invalid hooks.json: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    manifest,
    manifestPath,
    components: {
      skills,
      mcpServers,
      agents,
      rules,
      hasHooks,
      sidecars,
    },
  };
}
