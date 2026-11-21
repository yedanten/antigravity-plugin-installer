#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePluginDir } from '../server/validator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const result = await validatePluginDir(root, { strict: true });

console.log(`Plugin validation (${root}):`);
console.log(`  Valid:      ${result.valid}`);
console.log(`  Manifest:   ${result.manifestPath}`);
console.log(`  Name:       ${result.manifest?.name}`);
console.log(`  Version:    ${result.manifest?.version}`);
console.log(`  Skills:     ${result.components.skills.join(', ') || '(none)'}`);
console.log(`  MCP:        ${result.components.mcpServers.join(', ') || '(none)'}`);
console.log(`  Agents:     ${result.components.agents.join(', ') || '(none)'}`);
console.log(`  Rules:      ${result.components.rules.join(', ') || '(none)'}`);
console.log(`  Hooks:      ${result.components.hasHooks ? 'yes' : 'no'}`);

if (result.warnings.length > 0) {
  console.log('\nWarnings:');
  for (const w of result.warnings) console.log(`  - ${w}`);
}

if (result.errors.length > 0) {
  console.error('\nErrors:');
  for (const e of result.errors) console.error(`  - ${e}`);
  process.exit(1);
}
