#!/usr/bin/env node
// Forbids OS-path handling outside the shared platform-paths helpers and
// hardcoded private-state literals outside the single source of truth.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const allow = new Set([
  'packages/core/src/platform-paths.ts',
  'packages/engine/src/platform-paths.ts',
  'packages/core/src/migration-config.ts', // POSIX-relative MigrationPathSchema contract
  'packages/llm-worker/src/bounded-worker.ts', // POSIX patch-path contract
  'scripts/check-portability-lint.mjs',
  'scripts/check-doc-links.mjs', // path.posix doc-link resolution
  'scripts/copilot-boundary-hook.mjs', // standalone hook; env-aware private root
]);
const violations = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git', '.mimocode', 'artifacts'].includes(entry.name)) continue;
      walk(path);
      continue;
    }
    if (!/\.(ts|mjs|js)$/.test(entry.name)) continue;
    const rel = relative(root, path).replaceAll('\\', '/');
    if (allow.has(rel)) continue;
    const text = readFileSync(path, 'utf8');
    if (text.includes("'.local/state/migration-harness'") || text.includes('".local/state/migration-harness"')
      || text.includes(`.local/state/migration-harness`)) {
      if (!rel.startsWith('docs/') && !/\.test\.mjs$/.test(rel) && !rel.startsWith('tests/')) {
        violations.push(`${rel}: hardcoded private state path; use privateBaseDir()/PRIVATE_STATE_FRAGMENT`);
      }
    }
    if (/\bjoin\(\s*homedir\(\)\s*,\s*['"]\.local/.test(text)) {
      violations.push(`${rel}: join(homedir(), '.local/...'); use privateBaseDir()`);
    }
    if (/\bstartsWith\(\s*`\$\{[^}]+\}\/`/.test(text) && !rel.includes('platform-paths') && !rel.endsWith('.test.mjs')) {
      violations.push(`${rel}: startsWith(\`\${root}/\`); use isWithin/coversPosix/pathSegments`);
    }
  }
};
walk(join(root, 'packages'));
walk(join(root, 'scripts'));
if (violations.length) {
  console.error('Portability lint failed:');
  for (const line of violations) console.error(`  ${line}`);
  process.exit(1);
}
console.log('Portability lint passed.');
