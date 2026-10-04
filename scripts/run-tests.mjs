#!/usr/bin/env node
/**
 * Runner Node portável do gate — substitui os `$(node tests/test-groups.mjs …)` dos scripts
 * (sintaxe POSIX que não roda no shell padrão do Windows). Recebe a camada, monta a lista no
 * manifesto, roda `node --test` com a concorrência certa e aplica a allowlist NOMEADA de skips.
 *
 * Uso: node scripts/run-tests.mjs l1|l2|l3|exclusive|l1-operations|l3-operations
 *
 * Cada camada roda primeiro os arquivos inteiros e depois cada recorte por nome (o
 * `--test-name-pattern` é global por invocação). O reporter `test-events-reporter.mjs` reemite o
 * TAP e grava os skips com o arquivo de origem; nenhum skip fora de `SKIP_ALLOWLIST` passa, em
 * qualquer SO. Um erro de teste, um skip não declarado ou zero testes aprovados falham o passo.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan, skipIsAllowed, ROOT } from '../tests/test-groups.mjs';

const REPORTER = fileURLToPath(new URL('./test-events-reporter.mjs', import.meta.url));
const CONCURRENCY = { l2: 2 };
const tempDir = mkdtempSync(join(tmpdir(), 'harness-run-tests-'));

const rel = file => relative(ROOT, file).split(sep).join('/');

function runNodeTest(files, { concurrency, namePattern }) {
  return new Promise(resolve => {
    const eventsFile = join(tempDir, `events-${Math.random().toString(36).slice(2)}.json`);
    const args = ['--test', `--test-concurrency=${concurrency}`, `--test-reporter=${REPORTER}`];
    if (namePattern) args.push(`--test-name-pattern=${namePattern}`);
    args.push(...files);
    console.error(`run-tests: node ${args.map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')}`);
    const child = spawn(process.execPath, args, {
      cwd: ROOT, env: { ...process.env, TEST_EVENTS_FILE: eventsFile }, stdio: ['ignore', 'pipe', 'inherit'],
    });
    const output = [];
    child.stdout.on('data', chunk => { output.push(chunk); process.stdout.write(chunk); });
    child.on('error', error => resolve({ status: 1, events: {}, output: output.join(''), error }));
    child.on('close', status => {
      let events = {};
      try { events = JSON.parse(readFileSync(eventsFile, 'utf8')); } catch { /* reporter indisponível */ }
      rmSync(eventsFile, { force: true });
      resolve({ status, events, output: output.join('') });
    });
  });
}

async function main() {
  const group = process.argv[2];
  const selected = group ? plan(group) : undefined;
  if (!selected) {
    console.error('uso: node scripts/run-tests.mjs l1|l2|l3|exclusive|l1-operations|l3-operations');
    process.exitCode = 2;
    return;
  }
  const os = process.platform;
  const totals = { tests: 0, pass: 0, fail: 0 };
  const skips = [];
  const failures = [];

  const invocations = [];
  if (selected.files.length) invocations.push({ files: selected.files, concurrency: CONCURRENCY[group] ?? 1 });
  for (const subset of selected.subsets) invocations.push({ files: [subset.file], concurrency: 1, namePattern: subset.namePattern });

  for (const invocation of invocations) {
    const { status, events, error } = await runNodeTest(invocation.files, invocation);
    if (error) failures.push(`${group}: falha ao iniciar node --test: ${error.message}`);
    if (status !== 0) failures.push(`${group}: node --test saiu com código ${status}`);
    for (const key of Object.keys(totals)) totals[key] += events.summary?.[key] ?? 0;
    skips.push(...(events.skips ?? []));
  }

  const violations = skips.filter(skip => !skipIsAllowed(skip, os));
  for (const skip of violations) failures.push(`${group}: skip não declarado em ${rel(skip.file)} :: ${skip.name} — "${skip.skip}" (${os})`);

  console.error(`run-tests ${group}: tests=${totals.tests} pass=${totals.pass} fail=${totals.fail} skips=${skips.length} declarados=${skips.length - violations.length}`);
  if (totals.pass === 0) failures.push(`${group}: nenhum teste aprovado (garantia essencial indisponível?)`);
  if (failures.length) {
    for (const failure of failures) console.error(`FALHA: ${failure}`);
    process.exitCode = 1;
  }
}

try { await main(); } finally { rmSync(tempDir, { recursive: true, force: true }); }
