#!/usr/bin/env node
/**
 * bench-verify.mjs — benchmark de prepare-migration + verify-migration (fase F0, docs/PLAN-V2.md §4).
 *
 * O que mede: o artefato `timings.json` que o engine grava no store de cada operação
 * (packages/engine/src/timings.ts), com uma linha por fase instrumentada (nome + duração em ms
 * + ids/contagens declarados). O benchmark roda N ciclos completos prepare → verify e reporta
 * p50/p95 por fase.
 *
 * Pré-requisitos e uso:
 *   corepack pnpm build                # os dist/ do engine precisam existir (ou `pnpm build`)
 *   node scripts/bench-verify.mjs       # 3 iterações (default), tabela no stdout
 *   node scripts/bench-verify.mjs --runs 5
 *   node scripts/bench-verify.mjs --json     # JSON no stdout; a tabela vai para o stderr
 *   node scripts/bench-verify.mjs --keep     # mantém artifacts/bench-verify/* no disco
 *   node scripts/bench-verify.mjs --no-build-cache   # ramo sem cache de build (A/B, PLAN-V2 §4.3)
 *   node scripts/bench-verify.mjs --with-required-check  # adiciona um check required não-build
 *   node scripts/bench-verify.mjs --help
 *
 * A/B do cache de build: `--no-build-cache` exporta MIGRATION_HARNESS_DISABLE_BUILD_CACHE=1, o
 * caminho sem cache que fica sempre disponível. Compare o mesmo número de runs nos dois braços.
 * O run 1 do braço com cache é frio (publica) e os runs seguintes são quentes; o braço sem cache
 * não tem essa distinção. `--with-required-check` injeta um lint required por lado para provar
 * que o ganho não vem de executar menos checks — ele roda nos dois braços.
 *
 * Fixture: tests/helpers/build-workspace.mjs — o caminho completo mais barato do repo
 * (builds por script node, 1 cenário, sourceRuns=2, reset ISOLATED_FIXTURES, chromium).
 * A captura exige Playwright/Chromium: sem browser o script falha dizendo o que falta.
 * Único ajuste no fixture: `limits.maxDurationMs` sobe para 600000 ms para o orçamento da
 * sessão não vencer sob carga paralela; nada mais é alterado.
 *
 * Fases (agregadas por nome ao longo dos runs):
 *   preflight | preflightBrowser | hashing-collect | suite | project-checks | builds | serve | boot |
 *   launch | context | navigation | steps | close | reset | capture | comparison | persistence
 * `preflight`, `suite` e `boot` são fases contêiner (marcadas com `*`): já incluem o trabalho
 * interno das subfases — some as demais (disjuntas) para aproximar o total.
 * Decomposição fina de uma captura (o span `boot` é a captura inteira; seus componentes são
 * disjuntos entre si e somam ≈ boot):
 *   launch      = chromium.launch() feito pela própria captura (só existe sem reuso de processo);
 *                 com reuso, o processo é lançado uma vez por operação e este span some
 *   context     = newContext + rotas + newPage (contexto NOVO por captura, sempre)
 *   navigation  = precondições/goto/boot do app servido + capturas iniciais
 *   steps       = passos do cenário + sinal de conclusão + capturas finais + finish do trace
 *   close       = context.close (+ browser.close quando a captura é dona do processo)
 * `preflightBrowser` = o chromium.launch() extra do preflight (span próprio dentro de `preflight`);
 * com reuso, é o único lançamento por operação e o `close` dele aparece no fim da operação.
 * `serve` = reserva de porta/serve gerenciado/teardown dos build-servers (não é boot de browser).
 *
 * Privacidade: só nomes de fase, durações e contagens são reportados; chaves privadas do store
 * são sempre removidas ao final (mesmo com --keep, que retém apenas os artefatos públicos).
 */
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const USAGE = `Uso: node scripts/bench-verify.mjs [--runs N] [--json] [--keep] [--no-build-cache] [--with-required-check] [--help]

  --runs N                 iterações prepare+verify (default 3, inteiro >= 1)
  --json                   imprime o JSON agregado no stdout (a tabela vai para o stderr)
  --keep                   mantém os artefatos públicos em artifacts/bench-verify/
  --no-build-cache         exporta MIGRATION_HARNESS_DISABLE_BUILD_CACHE=1 (braço A/B sem cache)
  --with-required-check    adiciona um check required não-build por lado ao fixture
  --help                   esta mensagem`;

const CONTAINERS = new Set(['preflight', 'suite', 'boot']);

function fail(message) {
  console.error(`bench-verify: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { runs: 3, json: false, keep: false, help: false, noBuildCache: false, withRequiredCheck: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--no-build-cache') options.noBuildCache = true;
    else if (arg === '--with-required-check') options.withRequiredCheck = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--runs' || arg.startsWith('--runs=')) {
      const raw = arg === '--runs' ? argv[++index] : arg.slice('--runs='.length);
      const runs = Number(raw);
      if (!Number.isInteger(runs) || runs < 1) fail(`--runs recebe um inteiro >= 1, recebi "${raw}"`);
      options.runs = runs;
    } else fail(`opção desconhecida: ${arg}\n\n${USAGE}`);
  }
  return options;
}

/** Linear-interpolation percentile over an unsorted sample. */
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

const round = value => Math.round(value * 10) / 10;

/** Collapse one operation's timing artifact into per-phase sums for this run. */
function collapse(timings) {
  const phases = {}, spans = {};
  for (const entry of timings.phases) {
    phases[entry.name] = round((phases[entry.name] ?? 0) + entry.ms);
    spans[entry.name] = (spans[entry.name] ?? 0) + 1;
  }
  return { totalMs: timings.totalMs, phases, spans };
}

async function readTimings(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (parsed?.schemaVersion !== '1' || !Array.isArray(parsed.phases)) throw new Error('schema');
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`timings.json ausente em ${path} — dist desatualizado? Rode \`pnpm build\` e repita.`);
    throw new Error(`timings.json inválido em ${path} (${error.message}) — dist desatualizado? Rode \`pnpm build\`.`);
  }
}

/** Aggregate per-run collapses: p50/p95 of the per-run sum of each phase name. */
function aggregate(operation, entries) {
  const names = [...new Set(entries.flatMap(entry => Object.keys(entry.phases)))];
  const totalMs = { p50: round(percentile(entries.map(entry => entry.totalMs), 0.5)),
    p95: round(percentile(entries.map(entry => entry.totalMs), 0.95)) };
  const phases = {};
  for (const name of names) {
    const values = entries.map(entry => entry.phases[name] ?? 0);
    const p50 = round(percentile(values, 0.5));
    phases[name] = { p50, p95: round(percentile(values, 0.95)),
      share: totalMs.p50 ? Math.round(p50 / totalMs.p50 * 1000) / 10 : 0,
      spans: entries.reduce((sum, entry) => sum + (entry.spans[name] ?? 0), 0) };
  }
  const rows = Object.entries(phases).sort((left, right) => right[1].p50 - left[1].p50);
  return { operation, runs: entries.length, totalMs, phases: Object.fromEntries(rows) };
}

function printReport(payload, out) {
  const write = line => out.write(`${line}\n`);
  write(`bench-verify — fixture: ${payload.fixture} | runs: ${payload.runs} | browser: chromium`
    + ` | build cache: ${payload.buildCache} | required check: ${payload.requiredCheck ? 'injected' : 'stock'}`);
  write('(*) fase contêiner: já inclui as subfases listadas; as demais fases são disjuntas entre si.');
  for (const [operation, stats] of Object.entries(payload.aggregate)) {
    const statuses = payload.samples.map(sample => sample[operation.split('-')[0]]?.status).filter(Boolean);
    write('');
    write(`${operation}  totalMs p50 ${stats.totalMs.p50}  p95 ${stats.totalMs.p95}  | status: ${statuses.join(', ')}`);
    write('  fase              n     p50(ms)     p95(ms)    share');
    for (const [name, phase] of Object.entries(stats.phases)) {
      const label = `${name}${CONTAINERS.has(name) ? ' *' : ''}`.padEnd(16);
      write(`  ${label} ${String(phase.spans).padStart(4)} ${String(phase.p50).padStart(11)} ${String(phase.p95).padStart(11)} ${String(phase.share).padStart(7)}%`);
    }
  }
  write('');
  write(options.keep
    ? 'arquivos de timing: artifacts/bench-verify/run-*/{prepare,verify}/timings.json (retidos por --keep)'
    : 'artefatos removidos ao final; use --keep para inspecionar artifacts/bench-verify/run-*/timings.json');
}

const options = parseArgs(process.argv.slice(2));
if (options.help) { console.log(USAGE); process.exit(0); }
// A/B: the no-cache path is always available; it is selected before any engine code runs.
if (options.noBuildCache) process.env.MIGRATION_HARNESS_DISABLE_BUILD_CACHE = '1';
else process.env.MIGRATION_HARNESS_BUILD_CACHE = '1'; // cache is opt-in since the P0 containment; the hot arm must enable it explicitly

const engineEntry = resolve('packages/engine/dist/migration-operations.js');
const runnerEntry = resolve('packages/engine/dist/scenario-runner/index.js');
if (!existsSync(engineEntry) || !existsSync(runnerEntry)) {
  fail('dist/ do engine ausente — rode `pnpm build` (ou `corepack pnpm build`) antes do benchmark.');
}

const { prepareMigration, verifyMigration } = await import(pathToFileURL(engineEntry).href);
const { ArtifactStore } = await import(pathToFileURL(resolve('packages/engine/dist/artifacts.js')).href);
const { buildWorkspace } = await import(pathToFileURL(resolve('tests/helpers/build-workspace.mjs')).href);
const { preflightBrowser } = await import(pathToFileURL(runnerEntry).href);

// Fast, explicit preflight: the capture path cannot run without Chromium.
try {
  await preflightBrowser();
} catch (error) {
  fail([
    'browser Chromium indisponível — a captura da suíte exige Playwright/Chromium, sem ele o',
    'prepare/verify completo não roda.',
    `detalhe: ${error && error.message ? error.message : error}`,
    'ação: `pnpm exec playwright install chromium` (e confirme que a instalação terminou).',
  ].join('\n'));
}

const fixture = await buildWorkspace();
const workspace = fixture.root;
const config = fixture.config;
config.profile = 'standard';
config.limits = { ...config.limits, maxDurationMs: 600_000 };
// Optional required non-build check: it executes on every cycle of both arms, so any gain can
// only come from the build command the cache satisfies — never from running fewer checks.
if (options.withRequiredCheck) {
  const lint = ['import { appendFileSync, mkdirSync } from \'node:fs\';',
    'mkdirSync(\'../markers\', { recursive: true });',
    'appendFileSync(\'../markers/lint.log\', \'run\\\\n\');'].join('\n');
  for (const side of ['source', 'target']) {
    await writeFile(join(workspace, side, 'lint.mjs'), lint);
    config[side].commands.push({ id: 'lint', kind: 'lint', argv: [process.execPath, 'lint.mjs'], cwd: '.', timeoutMs: 3000 });
    config.checks.push({ id: `lint-${side}`, side, commandId: 'lint', required: true });
  }
}

/** Remove the private store roots (always) and, unless --keep, the whole fixture workspace. */
const cleanup = async ({ keepPublic }) => {
  for (const dir of artifactDirs) {
    await rm(new ArtifactStore(join(workspace, dir)).privateRoot, { recursive: true, force: true });
  }
  if (!keepPublic) await rm(workspace, { recursive: true, force: true });
};

const samples = [];
const artifactDirs = [];
const status = line => process.stderr.write(`${line}\n`);
let failed = null;
try {
  for (let run = 1; run <= options.runs && !failed; run++) {
    const preparePath = `artifacts/bench-verify/run-${run}/prepare`;
    const verifyPath = `artifacts/bench-verify/run-${run}/verify`;
    artifactDirs.push(preparePath, `${preparePath}/capture`, verifyPath, `${verifyPath}/capture`);
    const started = performance.now();
    try {
      const preparation = await prepareMigration({ config, workspaceRoot: workspace, artifactPath: preparePath, allowProjectCommands: true });
      if (preparation.kind !== 'MIGRATION_PREPARATION') {
        const codes = (preparation.diagnostics ?? []).map(item => item.detailCode ?? item.code).join(', ');
        failed = `prepare terminou em ${preparation.status} sem preparação (${codes || 'sem diagnóstico'}) — veja ${preparePath}/preflight.json`;
        break;
      }
      const report = await verifyMigration({ config, workspaceRoot: workspace, artifactPath: verifyPath,
        allowProjectCommands: true, preparation });
      const prepareTimings = await readTimings(join(workspace, preparePath, 'timings.json'));
      const verifyTimings = await readTimings(join(workspace, verifyPath, 'timings.json'));
      samples.push({ run, wallMs: round(performance.now() - started),
        prepare: { status: preparation.status, ...collapse(prepareTimings) },
        verify: { status: report.status, ...collapse(verifyTimings) } });
      status(`run ${run}/${options.runs}: prepare=${preparation.status} verify=${report.status} wall=${samples.at(-1).wallMs}ms`);
    } catch (error) {
      failed = `run ${run} falhou: ${error && error.message ? error.message : error}`;
    }
  }
} finally {
  await cleanup({ keepPublic: options.keep && !failed });
}

if (failed) fail(failed);
if (!samples.length) fail('nenhum run concluído.');

const payload = {
  schemaVersion: '1',
  tool: 'scripts/bench-verify.mjs',
  fixture: 'tests/helpers/build-workspace.mjs',
  runs: options.runs,
  buildCache: options.noBuildCache ? 'off' : 'on',
  requiredCheck: options.withRequiredCheck,
  samples,
  aggregate: {
    'prepare-migration': aggregate('prepare-migration', samples.map(sample => sample.prepare)),
    'verify-migration': aggregate('verify-migration', samples.map(sample => sample.verify)),
  },
};

if (options.json) {
  printReport(payload, process.stderr);
  console.log(JSON.stringify(payload, null, 2));
} else {
  printReport(payload, process.stdout);
}
