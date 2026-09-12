import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';

// Resolve against tracked paths so ignored local migrations cannot hide broken
// links in the repository a contributor actually clones.
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean));
let checked = 0;
const failures = [];
for (const path of [...tracked].filter(path => path.endsWith('.md'))) {
  const body = (await readFile(resolve(root, path), 'utf8')).replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, '');
  for (const match of body.matchAll(/!?\[[^\]\n]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1].replace(/^<|>$/g, '').split('#')[0];
    if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
    const local = posix.normalize(posix.join(dirname(path), decodeURIComponent(target)));
    checked++;
    if (!tracked.has(local) && ![...tracked].some(file => file.startsWith(`${local}/`))) failures.push(`${path}: ${target}`);
  }
}
if (failures.length) {
  console.error(`Links outside the published checkout:\n${failures.join('\n')}`);
  process.exitCode = 1;
} else console.log(`Published documentation links: ${checked} checked, PASS`);
