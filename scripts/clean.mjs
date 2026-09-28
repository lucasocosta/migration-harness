#!/usr/bin/env node
// Cross-platform clean: remove package dist directories without find/rm.
import { rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(process.cwd(), 'packages');
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dist = join(root, entry.name, 'dist');
  try {
    if (statSync(dist).isDirectory()) rmSync(dist, { recursive: true, force: true });
  } catch { /* missing is fine */ }
}
