#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePluginDir } from '../server/validator.mjs';
import { stageDeployablePlugin } from './install-local.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function isGitIgnoredLocalAgentsFile(repoRoot) {
  try {
    execFileSync('git', ['check-ignore', '-q', 'AGENTS.md'], {
      cwd: repoRoot,
      stdio: 'ignore',
      windowsHide: true,
    });
    const tracked = execFileSync('git', ['ls-files', 'AGENTS.md'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    return tracked === '';
  } catch {
    return false;
  }
}

let targetDir = root;
let stagedDir = null;

try {
  await fs.access(path.join(root, 'AGENTS.md'));
  if (isGitIgnoredLocalAgentsFile(root)) {
    stagedDir = await stageDeployablePlugin(root);
    targetDir = stagedDir;
  }
} catch {
  // No local AGENTS.md; validate repo root directly
}

try {
  const result = await validatePluginDir(targetDir, { strict: true });

  console.log(`Plugin validation (${stagedDir ? `${root} [staged clean package]` : root}):`);
  console.log(`  Valid:      ${result.valid}`);
  console.log(`  Manifest:   ${result.manifestPath}`);
  console.log(`  Name:       ${result.manifest?.name}`);
  console.log(`  Version:    ${result.manifest?.version}`);
  console.log(`  Skills:     ${result.components.skills.join(', ') || '(none)'}`);
  console.log(`  MCP:        ${result.components.mcpServers.join(', ') || '(none)'}`);
  console.log(`  Agents:     ${result.components.agents.join(', ') || '(none)'}`);
  console.log(`  Rules:      ${result.components.rules.join(', ') || '(none)'}`);
  console.log(`  Hooks:      ${result.components.hasHooks ? 'yes' : 'no'}`);
  console.log(`  Sidecars:   ${(result.components.sidecars || []).join(', ') || '(none)'}`);

  if (result.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const w of result.warnings) console.log(`  - ${w}`);
  }

  if (result.errors.length > 0) {
    console.error('\nErrors:');
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
} finally {
  if (stagedDir) {
    await fs.rm(stagedDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
