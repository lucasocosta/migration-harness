#!/usr/bin/env node
// Cross-platform clean: remove package dist directories and tsc build stamps without find/rm.
// Build stamps must go too: after a dist-only clean, `tsc -b` considers everything up to date
// and silently emits nothing (empty dist, "successful" build).
import { rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(process.cwd(), 'packages');
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  for (const target of ['dist', 'tsconfig.tsbuildinfo']) {
    try {
      if (statSync(join(root, entry.name, target))) rmSync(join(root, entry.name, target), { recursive: true, force: true });
    } catch { /* missing is fine */ }
  }
}
try { rmSync(join(process.cwd(), 'tsconfig.tsbuildinfo'), { force: true }); } catch { /* missing is fine */ }
