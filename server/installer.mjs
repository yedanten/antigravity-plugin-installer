import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import {
  expandHomePath,
  getGlobalPluginsDir,
  getWorkspacePluginsDir,
  isSamePath,
  readEnabledOverrides,
  registryKey,
  setPluginEnabled as defaultSetPluginEnabled,
} from './plugins.mjs';
import {
  findManifestPath,
  parseJsonc,
  sanitizePluginDirName,
  validatePluginDir,
} from './validator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const RETRYABLE_RM_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

const execFileAsync = promisify(execFile);

export const NPM_REGISTRIES = {
  official: 'https://registry.npmjs.org',
  npmmirror: 'https://registry.npmmirror.com',
};

const MAX_TARBALL_BYTES = 50 * 1024 * 1024; // 50 MiB
const SKIP_COPY_NAMES = new Set(['.git', '.DS_Store', 'Thumbs.db', 'desktop.ini']);

function stripQuotes(str) {
  let s = String(str || '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function isLikelyLocalPath(str) {
  if (!str) return false;
  if (str.startsWith('file://')) return true;
  if (str.startsWith('/') || str.startsWith('~/') || str.startsWith('~\\')) return true;
  if (str.startsWith('./') || str.startsWith('../') || str.startsWith('.\\') || str.startsWith('..\\')) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/.test(str)) return true;
  if (str.startsWith('\\\\')) return true;
  return false;
}

function parseNpmSpec(raw) {
  let spec = stripQuotes(raw);
  if (spec.startsWith('npm:')) {
    spec = spec.slice(4).trim();
  }
  const npmUrlMatch = spec.match(/^https?:\/\/(?:www\.)?npmjs\.com\/package\/(.+?)(?:[?#].*)?$/i);
  if (npmUrlMatch) {
    spec = decodeURIComponent(npmUrlMatch[1]).replace(/\/+$/, '');
    spec = spec.replace(/\/v\/([^/]+)$/, '@$1');
  }

  let pkgName = spec;
  let version = 'latest';

  if (spec.startsWith('@')) {
    const slashIdx = spec.indexOf('/');
    if (slashIdx === -1) {
      throw new Error(`Invalid scoped npm package name: "${spec}"`);
    }
    const atIdx = spec.indexOf('@', slashIdx + 1);
    if (atIdx !== -1) {
      pkgName = spec.slice(0, atIdx);
      version = spec.slice(atIdx + 1) || 'latest';
    }
  } else {
    const atIdx = spec.indexOf('@');
    if (atIdx !== -1) {
      pkgName = spec.slice(0, atIdx);
      version = spec.slice(atIdx + 1) || 'latest';
    }
  }

  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(pkgName)) {
    throw new Error(`Invalid npm package name: "${pkgName}"`);
  }

  return {
    type: 'npm',
    packageName: pkgName,
    version,
    displaySource: version && version !== 'latest' ? `${pkgName}@${version}` : pkgName,
  };
}

function parseGitHubSpec(raw, { ref: explicitRef = '', subpath: explicitSubpath = '' } = {}) {
  let input = stripQuotes(raw);
  let owner = '';
  let repo = '';
  let ref = explicitRef.trim();
  let subpath = explicitSubpath.trim().replace(/^\/+|\/+$/g, '');
  let cloneUrl = '';

  if (input.startsWith('github:')) {
    input = input.slice('github:'.length).trim();
  }

  // SSH URL: git@github.com:owner/repo(.git)
  const sshMatch = input.match(/^git@github\.com:([^/\s]+)\/([^/\s#]+?)(?:\.git)?(?:#(.+))?$/i);
  if (sshMatch) {
    owner = sshMatch[1];
    repo = sshMatch[2];
    if (!ref && sshMatch[3]) ref = sshMatch[3];
    cloneUrl = `git@github.com:${owner}/${repo}.git`;
  } else {
    // HTTPS or github.com/owner/repo...
    let normalized = input;
    if (/^github\.com\//i.test(normalized)) {
      normalized = `https://${normalized}`;
    }

    if (/^https?:\/\/(?:www\.)?github\.com\//i.test(normalized)) {
      const url = new URL(normalized);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length < 2) {
        throw new Error(`GitHub URL must include owner and repository: "${input}"`);
      }
      owner = parts[0];
      repo = parts[1].replace(/\.git$/i, '');

      if (parts[2] === 'tree' && parts.length >= 4) {
        if (!ref) ref = decodeURIComponent(parts[3]);
        if (!subpath && parts.length > 4) {
          subpath = parts.slice(4).map(decodeURIComponent).join('/');
        }
      }
      if (!ref && url.hash) {
        ref = url.hash.slice(1);
      }
      cloneUrl = `https://github.com/${owner}/${repo}.git`;
    } else {
      // Shorthand: owner/repo(#ref) or owner/repo/subdir
      let hashRef = '';
      const hashIdx = input.indexOf('#');
      if (hashIdx !== -1) {
        hashRef = input.slice(hashIdx + 1).trim();
        input = input.slice(0, hashIdx).trim();
      }
      const parts = input.split('/').filter(Boolean);
      if (parts.length < 2) {
        throw new Error(`Invalid GitHub repository format: "${raw}". Use https://github.com/owner/repo or owner/repo.`);
      }
      owner = parts[0];
      repo = parts[1].replace(/\.git$/i, '');
      if (!ref && hashRef) ref = hashRef;
      if (!subpath && parts.length > 2) {
        subpath = parts.slice(2).join('/');
      }
      cloneUrl = `https://github.com/${owner}/${repo}.git`;
    }
  }

  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid GitHub owner/repository identifier: "${owner}/${repo}"`);
  }

  return {
    type: 'github',
    owner,
    repo,
    ref,
    subpath,
    cloneUrl,
    webUrl: `https://github.com/${owner}/${repo}`,
    displaySource: `${owner}/${repo}${ref ? `#${ref}` : ''}${subpath ? ` (${subpath})` : ''}`,
  };
}

function parseLocalSpec(raw) {
  let cleaned = stripQuotes(raw);
  if (cleaned.startsWith('file://')) {
    cleaned = fileURLToPath(cleaned);
  }
  const resolvedPath = expandHomePath(cleaned);
  return {
    type: 'local',
    localPath: resolvedPath,
    displaySource: resolvedPath,
  };
}

export async function parsePluginSource(rawInput, options = {}) {
  const cleaned = stripQuotes(rawInput);
  if (!cleaned) {
    throw new Error('Please enter a GitHub URL, npm package name, or local directory path.');
  }

  const forcedType = options.sourceType && options.sourceType !== 'auto' ? options.sourceType : null;

  if (forcedType === 'github') {
    return parseGitHubSpec(cleaned, options);
  }
  if (forcedType === 'npm') {
    return parseNpmSpec(cleaned);
  }
  if (forcedType === 'local') {
    return parseLocalSpec(cleaned);
  }

  // Auto-detect
  if (
    /^https?:\/\/(?:www\.)?github\.com\//i.test(cleaned) ||
    /^github\.com\//i.test(cleaned) ||
    /^git@github\.com:/i.test(cleaned) ||
    cleaned.startsWith('github:')
  ) {
    return parseGitHubSpec(cleaned, options);
  }

  if (
    /^https?:\/\/(?:www\.)?npmjs\.com\/package\//i.test(cleaned) ||
    cleaned.startsWith('npm:')
  ) {
    return parseNpmSpec(cleaned);
  }

  if (isLikelyLocalPath(cleaned)) {
    return parseLocalSpec(cleaned);
  }

  if (cleaned.startsWith('@')) {
    return parseNpmSpec(cleaned);
  }

  // If it exists as a directory on disk, treat as local path
  try {
    const stat = await fs.stat(expandHomePath(cleaned));
    if (stat.isDirectory()) {
      return parseLocalSpec(cleaned);
    }
  } catch {
    // Not an existing local directory
  }

  if (cleaned.includes('/') && !cleaned.startsWith('http://') && !cleaned.startsWith('https://')) {
    return parseGitHubSpec(cleaned, options);
  }

  if (/^[a-z0-9._-]+(?:@[^@\s]+)?$/i.test(cleaned)) {
    return parseNpmSpec(cleaned);
  }

  throw new Error(
    `Could not recognize plugin source "${cleaned}". Enter a GitHub URL, npm package name, or local directory path.`,
  );
}

/**
 * Pure Node.js safe .tar.gz extractor (supports USTAR, GNU LongLink, and PAX path).
 * Prevents path traversal (ZipSlip) and enforces size bounds.
 */
export async function extractTarGz(buffer, destDir) {
  const tarBuf = zlib.gunzipSync(buffer);
  const resolvedDest = path.resolve(destDir);
  await fs.mkdir(resolvedDest, { recursive: true });

  let offset = 0;
  let totalWritten = 0;
  let nextLongPath = null;

  const readString = (buf, start, len) => {
    const slice = buf.subarray(start, start + len);
    const nullIdx = slice.indexOf(0);
    return slice.subarray(0, nullIdx === -1 ? len : nullIdx).toString('utf8');
  };

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    offset += 512;

    // Two consecutive zero blocks mark end-of-archive
    let allZero = true;
    for (let i = 0; i < 512; i += 1) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const rawName = readString(header, 0, 100);
    const sizeOctal = readString(header, 124, 12).trim();
    const typeFlag = String.fromCharCode(header[156] || 0);
    const prefix = readString(header, 345, 155);
    const fileSize = sizeOctal ? parseInt(sizeOctal, 8) : 0;

    if (!Number.isFinite(fileSize) || fileSize < 0) {
      throw new Error('Corrupt tar archive: invalid entry size.');
    }

    const dataStart = offset;
    const dataEnd = dataStart + fileSize;
    const paddedBlocks = Math.ceil(fileSize / 512) * 512;
    offset += paddedBlocks;

    if (dataEnd > tarBuf.length) {
      throw new Error('Corrupt tar archive: truncated entry.');
    }

    const entryData = tarBuf.subarray(dataStart, dataEnd);

    // GNU LongLink
    if (typeFlag === 'L') {
      nextLongPath = readString(entryData, 0, entryData.length);
      continue;
    }

    // PAX extended header
    if (typeFlag === 'x' || typeFlag === 'g') {
      const text = entryData.toString('utf8');
      for (const line of text.split('\n')) {
        const spaceIdx = line.indexOf(' ');
        if (spaceIdx === -1) continue;
        const kv = line.slice(spaceIdx + 1);
        if (kv.startsWith('path=')) {
          nextLongPath = kv.slice(5);
        }
      }
      continue;
    }

    const entryName = nextLongPath || (prefix ? `${prefix}/${rawName}` : rawName);
    nextLongPath = null;

    if (!entryName || entryName === '.' || entryName === './') continue;

    // Normalize & guard against path traversal
    const normalizedRel = entryName.replace(/\\/g, '/').replace(/^\/+/, '');
    if (normalizedRel.split('/').includes('..')) {
      throw new Error(`Unsafe archive entry path rejected: ${entryName}`);
    }

    const outPath = path.resolve(resolvedDest, normalizedRel);
    if (!outPath.startsWith(resolvedDest + path.sep) && outPath !== resolvedDest) {
      throw new Error(`Unsafe archive entry escaped destination: ${entryName}`);
    }

    if (typeFlag === '5') {
      await fs.mkdir(outPath, { recursive: true });
    } else if (typeFlag === '0' || typeFlag === '\0') {
      totalWritten += fileSize;
      if (totalWritten > MAX_TARBALL_BYTES) {
        throw new Error('Archive exceeds maximum allowed uncompressed size (50 MiB).');
      }
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, entryData);
    }
    // Symlinks / hardlinks inside remote tarballs are intentionally skipped for security
  }
}

async function copyDirFiltered(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_COPY_NAMES.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirFiltered(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      const target = await fs.readlink(srcPath);
      await fs.symlink(target, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function resolvePluginRootInExtracted(baseDir, explicitSubpath = '') {
  const resolvedBase = path.resolve(baseDir);

  if (explicitSubpath) {
    const candidate = path.resolve(resolvedBase, explicitSubpath);
    if (!candidate.startsWith(resolvedBase + path.sep) && candidate !== resolvedBase) {
      throw new Error('Subdirectory path escapes the downloaded repository.');
    }
    if (await findManifestPath(candidate)) {
      return { pluginRoot: candidate, note: `Used subdirectory "${explicitSubpath}".` };
    }
    throw new Error(`No plugin.json found in subdirectory "${explicitSubpath}".`);
  }

  if (await findManifestPath(resolvedBase)) {
    return { pluginRoot: resolvedBase, note: 'Found plugin.json at repository root.' };
  }

  // Search one level deep and under plugins/
  const found = [];
  const searchDirs = [resolvedBase, path.join(resolvedBase, 'plugins')];
  for (const dir of searchDirs) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const candidate = path.join(dir, entry.name);
      if (await findManifestPath(candidate)) {
        found.push(candidate);
      }
    }
  }

  if (found.length === 1) {
    const rel = path.relative(resolvedBase, found[0]).replace(/\\/g, '/');
    return { pluginRoot: found[0], note: `Auto-detected plugin at "${rel}".` };
  }

  if (found.length > 1) {
    const rels = found.map((p) => path.relative(resolvedBase, p).replace(/\\/g, '/'));
    throw new Error(
      `Multiple plugins found in this repository (${rels.join(', ')}). Specify one in the Subdirectory field.`,
    );
  }

  throw new Error(
    'No plugin.json (or .antigravity-plugin/plugin.json, .gemini-plugin/plugin.json) found in the repository root or subdirectories.',
  );
}

async function fetchGitHubToDir(spec, stageDir, steps) {
  const repoDir = path.join(stageDir, 'repo');

  // Prefer git clone --depth 1 (works with SSH and git credentials)
  let cloned = false;
  try {
    const args = ['clone', '--depth', '1'];
    if (spec.ref) {
      args.push('--branch', spec.ref);
    }
    args.push(spec.cloneUrl, repoDir);

    await execFileAsync('git', args, { timeout: 120_000 });
    cloned = true;
    steps.push({
      phase: 'fetch',
      status: 'ok',
      message: `Cloned ${spec.owner}/${spec.repo}${spec.ref ? ` (${spec.ref})` : ''} via git.`,
    });
  } catch (gitErr) {
    // If branch clone failed (e.g., commit SHA) or git is unavailable, fallback to codeload tarball for HTTPS
    if (spec.cloneUrl.startsWith('https://')) {
      await fs.rm(repoDir, { recursive: true, force: true }).catch(() => {});
      const refSeg = encodeURIComponent(spec.ref || 'HEAD');
      const tarballUrl = `https://codeload.github.com/${spec.owner}/${spec.repo}/tar.gz/${refSeg}`;
      const res = await fetch(tarballUrl, {
        headers: { 'User-Agent': 'antigravity-plugin-installer/1.0' },
        redirect: 'follow',
      });
      if (!res.ok) {
        const gitMsg = gitErr instanceof Error ? gitErr.message : String(gitErr);
        throw new Error(
          `Failed to fetch GitHub repository (HTTP ${res.status}). Git output: ${gitMsg}`,
        );
      }
      const arrBuf = await res.arrayBuffer();
      const extractDir = path.join(stageDir, 'tarball');
      await extractTarGz(Buffer.from(arrBuf), extractDir);

      // GitHub tarballs wrap content in a single top-level "<repo>-<ref>/" folder
      const topEntries = await fs.readdir(extractDir, { withFileTypes: true });
      const topDir = topEntries.find((e) => e.isDirectory());
      if (!topDir) {
        throw new Error('Downloaded GitHub archive did not contain a repository folder.');
      }
      await fs.rename(path.join(extractDir, topDir.name), repoDir);
      cloned = true;
      steps.push({
        phase: 'fetch',
        status: 'ok',
        message: `Downloaded ${spec.owner}/${spec.repo} archive from GitHub.`,
      });
    } else {
      throw new Error(`git clone failed: ${gitErr instanceof Error ? gitErr.message : String(gitErr)}`);
    }
  }

  if (!cloned) {
    throw new Error('Failed to fetch GitHub repository.');
  }

  return resolvePluginRootInExtracted(repoDir, spec.subpath);
}

function resolveNpmVersion(pkgDoc, requestedVersion) {
  const distTags = pkgDoc['dist-tags'] || {};
  const versions = pkgDoc.versions || {};

  if (!requestedVersion || requestedVersion === 'latest') {
    const tagVer = distTags.latest;
    if (tagVer && versions[tagVer]) return versions[tagVer];
  }

  if (distTags[requestedVersion] && versions[distTags[requestedVersion]]) {
    return versions[distTags[requestedVersion]];
  }

  if (versions[requestedVersion]) {
    return versions[requestedVersion];
  }

  // Basic ^ / ~ range support by selecting highest matching semver
  const rangeMatch = requestedVersion.match(/^([\^~])(\d+)\.(\d+)\.(\d+)/);
  if (rangeMatch) {
    const [, op, majStr, minStr, patStr] = rangeMatch;
    const maj = Number(majStr);
    const min = Number(minStr);
    const pat = Number(patStr);
    const candidates = Object.keys(versions)
      .map((v) => {
        const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
        return m ? { v, maj: Number(m[1]), min: Number(m[2]), pat: Number(m[3]) } : null;
      })
      .filter(Boolean)
      .filter((c) => {
        if (op === '^') {
          if (c.maj !== maj) return false;
          if (c.min < min) return false;
          if (c.min === min && c.pat < pat) return false;
          return true;
        }
        return c.maj === maj && c.min === min && c.pat >= pat;
      })
      .sort((a, b) => b.maj - a.maj || b.min - a.min || b.pat - a.pat);

    if (candidates.length > 0) {
      return versions[candidates[0].v];
    }
  }

  throw new Error(
    `Version "${requestedVersion}" not found for npm package "${pkgDoc.name}".`,
  );
}

function normalizeRegistryUrl(rawRegistry) {
  const trimmed = String(rawRegistry || '').trim();
  if (!trimmed || trimmed === 'official') return NPM_REGISTRIES.official;
  if (trimmed === 'npmmirror') return NPM_REGISTRIES.npmmirror;
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('Custom npm registry must start with https:// or http://.');
  }
  return trimmed.replace(/\/+$/, '');
}

async function fetchNpmToDir(spec, { registry, subpath = '' }, stageDir, steps) {
  const registryUrl = normalizeRegistryUrl(registry);
  const encodedName = spec.packageName.startsWith('@')
    ? `@${encodeURIComponent(spec.packageName.slice(1))}`
    : encodeURIComponent(spec.packageName);

  const metaUrl = `${registryUrl}/${encodedName}`;
  const res = await fetch(metaUrl, {
    headers: {
      Accept: 'application/vnd.npm.install-v1+json, application/json',
      'User-Agent': 'antigravity-plugin-installer/1.0',
    },
  });

  if (!res.ok) {
    throw new Error(
      `Failed to fetch npm package "${spec.packageName}" from ${registryUrl} (HTTP ${res.status}).`,
    );
  }

  const pkgDoc = await res.json();
  const verDoc = resolveNpmVersion(pkgDoc, spec.version);
  const tarballUrl = verDoc?.dist?.tarball;
  if (!tarballUrl) {
    throw new Error(`No tarball URL found for ${spec.packageName}@${verDoc?.version || spec.version}.`);
  }

  steps.push({
    phase: 'fetch',
    status: 'ok',
    message: `Resolved ${spec.packageName}@${verDoc.version} from ${registryUrl}.`,
  });

  const tgzRes = await fetch(tarballUrl, {
    headers: { 'User-Agent': 'antigravity-plugin-installer/1.0' },
  });
  if (!tgzRes.ok) {
    throw new Error(`Failed to download tarball (HTTP ${tgzRes.status}).`);
  }

  const tgzBuf = Buffer.from(await tgzRes.arrayBuffer());
  const extractDir = path.join(stageDir, 'npm-extracted');
  await extractTarGz(tgzBuf, extractDir);

  const pkgDir = path.join(extractDir, 'package');
  let rootCandidate = extractDir;
  try {
    const st = await fs.stat(pkgDir);
    if (st.isDirectory()) rootCandidate = pkgDir;
  } catch {
    // Some custom tarballs may not wrap in package/
  }

  const resolved = await resolvePluginRootInExtracted(rootCandidate, subpath);

  // Install runtime dependencies if the npm plugin declares them
  try {
    const pkgJsonRaw = await fs.readFile(path.join(resolved.pluginRoot, 'package.json'), 'utf8');
    const pkgJson = JSON.parse(pkgJsonRaw);
    const hasDeps = pkgJson.dependencies && Object.keys(pkgJson.dependencies).length > 0;
    if (hasDeps) {
      const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      await execFileAsync(
        npmBin,
        ['install', '--omit=dev', '--no-audit', '--no-fund', `--registry=${registryUrl}`],
        {
          cwd: resolved.pluginRoot,
          timeout: 180_000,
          shell: process.platform === 'win32',
        },
      );
      steps.push({
        phase: 'deps',
        status: 'ok',
        message: 'Installed runtime npm dependencies.',
      });
    }
  } catch (depErr) {
    // Only warn if package.json exists and npm install failed
    if (depErr && depErr.code !== 'ENOENT') {
      steps.push({
        phase: 'deps',
        status: 'warn',
        message: `Skipped runtime dependency install: ${depErr instanceof Error ? depErr.message : String(depErr)}`,
      });
    }
  }

  return {
    ...resolved,
    resolvedVersion: verDoc.version,
    registryUrl,
  };
}

export async function previewPluginSource({ source, sourceType = 'auto', ref = '', subpath = '' }) {
  const parsed = await parsePluginSource(source, { sourceType, ref, subpath });
  const extra = {};

  if (parsed.type === 'local') {
    try {
      const validation = await validatePluginDir(parsed.localPath, { strict: false });
      extra.localExists = true;
      extra.valid = validation.valid;
      extra.detectedName = validation.manifest?.displayName || validation.manifest?.name || path.basename(parsed.localPath);
      extra.errors = validation.errors;
      extra.components = validation.components;
    } catch {
      extra.localExists = false;
    }
  }

  return {
    ok: true,
    parsed,
    ...extra,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveExistingEnabledState(dirName, destPath) {
  const overrides = await readEnabledOverrides();
  const override = Object.hasOwn(overrides, dirName) ? overrides[dirName] : undefined;
  if (override && typeof override.enabled === 'boolean') {
    return { enabled: override.enabled, hasOverride: true };
  }
  try {
    const manifestPath = await findManifestPath(destPath);
    if (manifestPath) {
      const raw = await fs.readFile(manifestPath, 'utf8');
      const manifest = parseJsonc(raw);
      return { enabled: manifest?.disabled !== true, hasOverride: false };
    }
  } catch {
    // Fall back to enabled default if existing manifest is unreadable
  }
  return { enabled: true, hasOverride: false };
}

async function removePathSafe(targetPath) {
  let st;
  try {
    st = await fs.lstat(targetPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
  if (st.isSymbolicLink()) {
    await fs.unlink(targetPath);
  } else {
    await fs.rm(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function removeBackupWithRetry(backupPath, steps) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await fs.rm(backupPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      return;
    } catch (err) {
      const code = err && typeof err === 'object' ? err.code : '';
      if (RETRYABLE_RM_CODES.has(code) && attempt < maxAttempts) {
        await sleep(150);
        continue;
      }
      steps.push({
        phase: 'cleanup',
        status: 'warn',
        message: `Installed successfully, but could not remove temporary backup "${path.basename(backupPath)}": ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
  }
}

async function prepareExistingForReplaceWithRetry(
  destPath,
  isSymlink,
  {
    retries = 12,
    delayMs = 450,
    removeTarget = null,
    moveExistingToBackup = null,
    backupPath = '',
  } = {},
) {
  const maxAttempts = Math.max(1, Number(retries) + 1);
  const waitMs = Math.max(0, Number(delayMs) || 0);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (typeof removeTarget === 'function') {
        await removeTarget(destPath, { isSymlink, attempt, backupPath });
        return { backupPath: null };
      }
      if (isSymlink) {
        await fs.unlink(destPath);
        return { backupPath: null };
      }
      if (typeof moveExistingToBackup === 'function') {
        await moveExistingToBackup(destPath, backupPath, { attempt });
      } else {
        await fs.rename(destPath, backupPath);
      }
      return { backupPath };
    } catch (err) {
      const code = err && typeof err === 'object' ? err.code : '';
      const canRetry = RETRYABLE_RM_CODES.has(code) && attempt < maxAttempts;
      if (!canRetry) {
        if (RETRYABLE_RM_CODES.has(code)) {
          const lockErr = new Error(
            `Failed to replace existing plugin directory "${path.basename(destPath)}" because files are locked (${code}): ${err instanceof Error ? err.message : String(err)}`,
          );
          lockErr.code = code;
          throw lockErr;
        }
        throw err;
      }
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    }
  }
  return { backupPath: null };
}

export async function installPlugin({
  source,
  sourceType = 'auto',
  registry = 'official',
  ref = '',
  subpath = '',
  mode = 'copy', // 'copy' | 'link' (link only for local)
  scope = 'global', // 'global' | 'workspace'
  workspacePath = '',
  targetDirName = '',
  overwrite = false,
  installRegistry = null,
  isPluginEnabled = null,
  setPluginEnabled = null,
  disableSettleMs = 400,
  removeRetries = 12,
  removeRetryDelayMs = 450,
  removeTarget = null,
  moveExistingToBackup = null,
  pluginRoot = PLUGIN_ROOT,
}) {
  const steps = [];
  const parsed = await parsePluginSource(source, { sourceType, ref, subpath });
  steps.push({
    phase: 'parse',
    status: 'ok',
    message: `Detected ${parsed.type} source: ${parsed.displaySource}`,
  });

  const targetRoot =
    scope === 'workspace' ? getWorkspacePluginsDir(workspacePath) : getGlobalPluginsDir();
  if (!targetRoot) {
    throw new Error('Workspace path is required when installing at workspace scope.');
  }

  const stageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-plugin-install-'));

  try {
    let sourcePluginRoot = '';
    let resolvedVersion = '';
    let usedRegistry = '';

    if (parsed.type === 'github') {
      const res = await fetchGitHubToDir(parsed, stageDir, steps);
      sourcePluginRoot = res.pluginRoot;
      steps.push({ phase: 'locate', status: 'ok', message: res.note });
    } else if (parsed.type === 'npm') {
      const res = await fetchNpmToDir(parsed, { registry, subpath }, stageDir, steps);
      sourcePluginRoot = res.pluginRoot;
      resolvedVersion = res.resolvedVersion || '';
      usedRegistry = res.registryUrl || '';
      steps.push({ phase: 'locate', status: 'ok', message: res.note });
    } else if (parsed.type === 'local') {
      let stat;
      try {
        stat = await fs.stat(parsed.localPath);
      } catch {
        throw new Error(`Local path does not exist: ${parsed.localPath}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Local path must be a directory: ${parsed.localPath}`);
      }
      sourcePluginRoot = parsed.localPath;
      steps.push({
        phase: 'fetch',
        status: 'ok',
        message: `Verified local directory: ${parsed.localPath}`,
      });
    }

    // Validate plugin structure & plugin.json BEFORE modifying live state
    const validation = await validatePluginDir(sourcePluginRoot, { strict: false });
    if (!validation.valid) {
      throw new Error(`Plugin validation failed:\n- ${validation.errors.join('\n- ')}`);
    }
    steps.push({
      phase: 'validate',
      status: 'ok',
      message: `Validated plugin "${validation.manifest?.name || path.basename(sourcePluginRoot)}" (${
        validation.components.skills.length
      } skills, ${validation.components.mcpServers.length} MCP servers).`,
    });

    const fallbackName =
      parsed.type === 'github'
        ? parsed.subpath
          ? path.basename(parsed.subpath)
          : parsed.repo
        : parsed.type === 'npm'
          ? parsed.packageName
          : path.basename(parsed.localPath);

    const dirName = sanitizePluginDirName(
      targetDirName || validation.manifest?.name || fallbackName,
    );

    const resolvedTargetRoot = path.resolve(targetRoot);
    const destPath = path.resolve(resolvedTargetRoot, dirName);
    if (!destPath.startsWith(resolvedTargetRoot + path.sep)) {
      throw new Error('Security violation: computed destination escapes plugins directory.');
    }

    // Prevent self-copying onto the exact same directory
    const sameLogicalDest =
      process.platform === 'win32'
        ? path.resolve(sourcePluginRoot).toLowerCase() === destPath.toLowerCase()
        : path.resolve(sourcePluginRoot) === destPath;
    if (sameLogicalDest) {
      throw new Error('Source directory is already the target installation directory.');
    }

    await fs.mkdir(resolvedTargetRoot, { recursive: true });

    let existingStat = null;
    try {
      existingStat = await fs.lstat(destPath);
    } catch {
      existingStat = null;
    }

    let wasEnabled = false;
    let autoDisabled = false;
    let restoredEnabled = false;
    let finalEnabled = validation.manifest?.disabled !== true;
    let hasExplicitOverride = false;
    let removedExisting = false;
    let backupPath = '';
    let movedToBackup = false;
    const previousLinkTarget = existingStat?.isSymbolicLink()
      ? await fs.readlink(destPath).catch(() => null)
      : null;

    const toggleFn =
      typeof setPluginEnabled === 'function' ? setPluginEnabled : defaultSetPluginEnabled;

    if (existingStat) {
      if (!overwrite) {
        const err = new Error(
          `Plugin directory "${dirName}" already exists. Enable "Overwrite existing plugin" to replace it.`,
        );
        err.code = 'PLUGIN_EXISTS';
        err.existingDir = dirName;
        throw err;
      }

      if (await isSamePath(destPath, pluginRoot)) {
        const selfErr = new Error(
          'Cannot update Plugin Installer from inside its own running MCP server. Use "npm run install:local" or update via Antigravity CLI.',
        );
        selfErr.code = 'SELF_UPDATE_BLOCKED';
        throw selfErr;
      }

      if (typeof isPluginEnabled === 'function') {
        wasEnabled = Boolean(await isPluginEnabled(dirName, destPath));
      } else {
        const existingState = await resolveExistingEnabledState(dirName, destPath);
        wasEnabled = existingState.enabled;
        hasExplicitOverride = existingState.hasOverride;
      }

      if (wasEnabled) {
        await toggleFn(dirName, false);
        autoDisabled = true;
        steps.push({
          phase: 'disable',
          status: 'ok',
          message: `Temporarily disabled "${dirName}" before updating.`,
        });
        if (disableSettleMs > 0) {
          await sleep(disableSettleMs);
        }
      }
    }

    const effectiveMode = parsed.type === 'local' && mode === 'link' ? 'link' : 'copy';

    try {
      if (existingStat) {
        const candidateBackupPath = path.join(
          resolvedTargetRoot,
          `.${dirName}.backup-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`,
        );
        const prep = await prepareExistingForReplaceWithRetry(
          destPath,
          existingStat.isSymbolicLink(),
          {
            retries: removeRetries,
            delayMs: removeRetryDelayMs,
            removeTarget,
            moveExistingToBackup,
            backupPath: candidateBackupPath,
          },
        );
        removedExisting = true;
        if (prep.backupPath) {
          backupPath = prep.backupPath;
          movedToBackup = true;
        }
        steps.push({
          phase: 'replace',
          status: 'ok',
          message: movedToBackup
            ? `Backed up previous installation of "${dirName}" before replacement.`
            : `Removed previous installation at "${dirName}".`,
        });
      }

      if (effectiveMode === 'link') {
        const linkType = process.platform === 'win32' ? 'junction' : 'dir';
        await fs.symlink(sourcePluginRoot, destPath, linkType);
        steps.push({
          phase: 'install',
          status: 'ok',
          message: `Linked local plugin (${linkType}) -> ${destPath}`,
        });
      } else {
        await copyDirFiltered(sourcePluginRoot, destPath);
        steps.push({
          phase: 'install',
          status: 'ok',
          message: `Installed plugin files to ${destPath}`,
        });
      }

      const meta = {
        dir: dirName,
        name: validation.manifest?.name || dirName,
        displayName: validation.manifest?.displayName || validation.manifest?.name || dirName,
        version: validation.manifest?.version || resolvedVersion || '',
        sourceType: parsed.type,
        rawSource: stripQuotes(source),
        displaySource: parsed.displaySource,
        registry: usedRegistry || (parsed.type === 'npm' ? normalizeRegistryUrl(registry) : ''),
        ref: parsed.ref || ref || '',
        subpath: parsed.subpath || subpath || '',
        mode: effectiveMode,
        scope,
        workspacePath: scope === 'workspace' ? path.resolve(workspacePath) : '',
        installedAt: new Date().toISOString(),
      };

      if (installRegistry) {
        await installRegistry.record(registryKey(scope, dirName, workspacePath), meta);
      }

      if (existingStat) {
        if (wasEnabled) {
          await toggleFn(dirName, true);
          restoredEnabled = true;
          finalEnabled = true;
          steps.push({
            phase: 'enable',
            status: 'ok',
            message: `Restored enabled state for "${dirName}".`,
          });
        } else {
          if (!hasExplicitOverride && validation.manifest?.disabled !== true) {
            await toggleFn(dirName, false);
          }
          restoredEnabled = false;
          finalEnabled = false;
        }
      } else {
        const currentState = await resolveExistingEnabledState(dirName, destPath);
        finalEnabled = currentState.enabled;
      }

      if (backupPath && (await pathExists(backupPath))) {
        await removeBackupWithRetry(backupPath, steps);
      }

      return {
        ok: true,
        overwrote: Boolean(existingStat),
        wasEnabled,
        autoDisabled,
        restoredEnabled,
        enabled: finalEnabled,
        plugin: {
          dir: dirName,
          name: meta.name,
          displayName: meta.displayName,
          version: meta.version,
          description: validation.manifest?.description || '',
          path: destPath,
          scope,
          mode: effectiveMode,
          sourceType: parsed.type,
          displaySource: parsed.displaySource,
          components: validation.components,
          warnings: validation.warnings,
        },
        steps,
      };
    } catch (err) {
      let cleanupOk = true;
      let restoreOk = true;

      if (movedToBackup && backupPath && (await pathExists(backupPath))) {
        if (await pathExists(destPath)) {
          try {
            await removePathSafe(destPath);
          } catch {
            cleanupOk = false;
            restoreOk = false;
          }
        }
        if (cleanupOk && !(await pathExists(destPath))) {
          try {
            await fs.rename(backupPath, destPath);
          } catch {
            restoreOk = false;
          }
        } else {
          restoreOk = false;
        }
      } else if (
        existingStat?.isSymbolicLink() &&
        removedExisting &&
        previousLinkTarget
      ) {
        if (await pathExists(destPath)) {
          try {
            await removePathSafe(destPath);
          } catch {
            cleanupOk = false;
            restoreOk = false;
          }
        }
        if (cleanupOk && !(await pathExists(destPath))) {
          const linkType = process.platform === 'win32' ? 'junction' : 'dir';
          try {
            await fs.symlink(previousLinkTarget, destPath, linkType);
          } catch {
            restoreOk = false;
          }
        } else {
          restoreOk = false;
        }
      }

      const hasValidManifest =
        cleanupOk &&
        restoreOk &&
        (await pathExists(destPath)) &&
        Boolean(await findManifestPath(destPath).catch(() => null));

      if (autoDisabled && hasValidManifest) {
        await toggleFn(dirName, true).catch(() => {});
      }
      throw err;
    }
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
}
