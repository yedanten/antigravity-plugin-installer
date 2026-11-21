#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePluginDir } from '../server/validator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const INCLUDE_FILES = ['plugin.json', 'mcp_config.json', 'README.md', 'README.zh-CN.md', 'LICENSE'];
const INCLUDE_DIRS = ['assets', 'server', 'skills'];

async function copyRecursive(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

const validation = await validatePluginDir(REPO_ROOT, { strict: true });
if (!validation.valid) {
  console.error('Validation failed:\n- ' + validation.errors.join('\n- '));
  process.exit(1);
}

const pluginsRoot =
  process.env.ANTIGRAVITY_PLUGINS_DIR ||
  path.join(os.homedir(), '.gemini', 'config', 'plugins');
const targetDir = path.join(pluginsRoot, validation.manifest.name);

await fs.mkdir(pluginsRoot, { recursive: true });

try {
  const st = await fs.lstat(targetDir);
  if (st.isSymbolicLink()) {
    await fs.unlink(targetDir);
  } else {
    await fs.rm(targetDir, { recursive: true, force: true });
  }
} catch {
  // Not installed yet
}

await fs.mkdir(targetDir, { recursive: true });

for (const file of INCLUDE_FILES) {
  const src = path.join(REPO_ROOT, file);
  try {
    await fs.copyFile(src, path.join(targetDir, file));
  } catch {
    // Optional doc file
  }
}

for (const dir of INCLUDE_DIRS) {
  const src = path.join(REPO_ROOT, dir);
  await copyRecursive(src, path.join(targetDir, dir));
}

console.log(`Synced "${validation.manifest.name}" v${validation.manifest.version} -> ${targetDir}`);
