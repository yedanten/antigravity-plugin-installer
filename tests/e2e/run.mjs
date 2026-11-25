#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TIER_FILES = {
  1: path.join(__dirname, 'tier1.e2e.test.mjs'),
  2: path.join(__dirname, 'tier2.e2e.test.mjs'),
  3: path.join(__dirname, 'tier3.e2e.test.mjs'),
  4: path.join(__dirname, 'tier4.e2e.test.mjs'),
};

function parseTierSelection(argv) {
  let rawTiers = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tests/e2e/run.mjs [--tier=1,2,3,4]');
      process.exit(0);
    } else if (arg.startsWith('--tier=')) {
      rawTiers = arg.slice('--tier='.length);
    } else if (arg === '--tier' && argv[i + 1]) {
      rawTiers = argv[i + 1];
      i += 1;
    }
  }

  if (!rawTiers) {
    return [1, 2, 3, 4];
  }

  const parsed = rawTiers
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && TIER_FILES[n]);

  if (parsed.length === 0) {
    console.error(`Invalid --tier selection: "${rawTiers}". Valid tiers are 1, 2, 3, 4.`);
    process.exit(1);
  }

  return Array.from(new Set(parsed)).sort((a, b) => a - b);
}

const selectedTiers = parseTierSelection(process.argv.slice(2));
const testFiles = selectedTiers.map((t) => TIER_FILES[t]);

console.log(`Running Plugin Installer E2E Suite (Tiers: ${selectedTiers.join(', ')})`);

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: path.resolve(__dirname, '..', '..'),
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(typeof result.status === 'number' ? result.status : 1);
