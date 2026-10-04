/**
 * Manifesto de camadas de teste — docs/PLAN-V2.md §11 e §11.1.
 *
 * Camadas por recurso, não por diretório:
 *  - L1        dev loop, meta < 60 s: sem chromium, sem builds de app, sem prepare/verify completo.
 *              Composição §11.1: os 27 arquivos leves (< 2 s na auditoria) + v2-privacy +
 *              build-servers + o subconjunto sem prepare/verify de migration-operations
 *              (E1_OPERATIONS abaixo) + build-servers.
 *  - L2        integração: CLI/processo/FS real sem fixture de browser (tests/browser/*) e sem
 *              portas fixas. Concorrência 2. Vários arquivos L2 disparam prepare/verify reais e
 *              com eles um probe de chromium; ganharam `t.skip` explícito por teste onde medido.
 *  - L3        browser/pesados: tests/browser/*, perf-browser-*, a characterization/v2 que roda
 *              prepare/verify completos (characterization-privacy, v2-decisions) e o complemento de
 *              migration-operations (E3_OPERATIONS abaixo), que toca preflight/verify completos.
 *  - exclusive serial: recursos globais compartilhados sem porta efêmera (motivo por arquivo).
 *
 * BURACO FECHADO (auditoria final P1): `tests/migration-operations.test.mjs` era coberto só como
 * o subconjunto `l1-operations` (5-7 testes filtrados) e `coverageGroups()` contava o ARQUIVO
 * INTEIRO como coberto em L1 — os testes das linhas 96-133 (stale-evidence/coverage) não rodavam
 * em camada nenhuma. Agora o arquivo é PARTIDO por nome entre duas camadas (L1 = testes sem
 * prepare/verify; L3 = complemento com preflight/verify completos) e `check` prova EXECUÇÃO:
 * a união dos `test()` selecionados por camada cobre todos os `test()` dos arquivos com seleção
 * por nome, sem sobra e sem duplicata. Contar nomes de arquivo não basta mais.
 *
 * SKIP_ALLOWLIST: a guarda de skips deixou de isentar por TEXTO do motivo (`POSIX`/`win32`) e
 * passou a uma allowlist NOMEADA de `{arquivo, teste, SO, motivo}` conhecida. Qualquer skip que
 * não case com uma entrada declarada falha o step, em qualquer SO; não há tolerância numérica
 * separada — a lista é o limite. A execução roda no `scripts/run-tests.mjs` (Node puro, portável).
 *
 * INVARIANTS: mapa dos 13 invariantes-contrato (kill switch) comportamento → teste → camada, no
 * formato `tests/INVARIANTS.md`, validado aqui (cada teste existe e tem exatamente uma camada que
 * o executa; o documento tem de bater com o mapa canônico).
 *
 * Pré-condição: build atualizado (`pnpm build`); nenhum script de camada reconstrói.
 * Gate (`pnpm test`) roda L1 > L2 > L3 > exclusive via `scripts/run-tests.mjs`, serial.
 * `pnpm test:fast` = L1 + L2 (L2 concorrência 2). Cada camada é uma lista explícita; `check`
 * prova que a união é exatamente tests/*.test.mjs + tests/browser/*.test.mjs (sem sobra e sem
 * duplicata) e que a seleção por nome é exata.
 *
 * Uso:
 *   node tests/test-groups.mjs l1|l2|l3|exclusive|all   imprime a lista de arquivos (stdout)
 *   node tests/test-groups.mjs l1-operations            roda o subconjunto sem prepare/verify
 *   node tests/test-groups.mjs l3-operations            roda o complemento (stale-evidence/preflight)
 *   node tests/test-groups.mjs check                    confere cobertura/execução e allowlist
 *   node tests/test-groups.mjs invariants               imprime o mapa (INVARIANTS.md)
 *   node tests/test-groups.mjs invariants --write       regrava tests/INVARIANTS.md
 *
 * TIMINGS_MS: medição da auditoria de 2026-10-03 (`node --test --test-concurrency=1` por arquivo,
 * wall clock), exceto os arquivos reescritos ou novos na reescrita v2 (api-first-acceptance,
 * characterization-verification-status, v2-decisions), medidos no kill switch.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const TIMINGS_MS = {
  'tests/api-first-acceptance.test.mjs': 176994,
  'tests/api-first-persistence.test.mjs': 30064,
  'tests/artifact-lifecycle.test.mjs': 3037,
  'tests/binding-suggestions.test.mjs': 144,
  'tests/build-servers.test.mjs': 9196,
  'tests/characterization-exit-codes.test.mjs': 18069,
  'tests/characterization-privacy.test.mjs': 11026,
  'tests/characterization-profiles.test.mjs': 20050,
  'tests/characterization-verification-status.test.mjs': 4395,
  'tests/cli-json.test.mjs': 2631,
  'tests/disposition-diagnostic-codes.test.mjs': 1026,
  'tests/equivalence-values.test.mjs': 291,
  'tests/equivalence.test.mjs': 241,
  'tests/expected-differences.test.mjs': 197,
  'tests/http-scenarios.test.mjs': 1499,
  'tests/managed-server.test.mjs': 5179,
  'tests/mcp-boundary.test.mjs': 2056,
  'tests/mcp-server.test.mjs': 1032,
  'tests/migration-operations.test.mjs': 9640,
  'tests/migration-reference.test.mjs': 1044,
  'tests/migration-report.test.mjs': 221,
  'tests/migration-scope-overlap.test.mjs': 121,
  'tests/migration-scope.test.mjs': 273,
  'tests/migration-session-update.test.mjs': 18330,
  'tests/migration-session.test.mjs': 13606,
  'tests/noise-suggestions.test.mjs': 156,
  'tests/perf-browser-cleanup.test.mjs': 3867,
  'tests/perf-browser-reuse.test.mjs': 4320,
  'tests/persistence-stability.test.mjs': 170,
  'tests/platform-paths.test.mjs': 84,
  'tests/prepare-retry.test.mjs': 4475,
  'tests/privacy-policy.test.mjs': 118,
  'tests/process-tree.test.mjs': 584,
  'tests/project-checks.test.mjs': 14211,
  'tests/project-reset.test.mjs': 4196,
  'tests/review-regressions.test.mjs': 1401,
  'tests/scenario-bindings.test.mjs': 162,
  'tests/security.test.mjs': 1041,
  'tests/serviceworker.test.mjs': 172,
  'tests/session-scope-guard.test.mjs': 10616,
  'tests/state-capture.test.mjs': 5405,
  'tests/state-claims.test.mjs': 971,
  'tests/state-schema.test.mjs': 195,
  'tests/unit-assertions.test.mjs': 241,
  'tests/v2-commands.test.mjs': 44365,
  'tests/v2-decisions.test.mjs': 26458,
  'tests/v2-envelope.test.mjs': 100,
  'tests/v2-polish-comparisons.test.mjs': 4479,
  'tests/v2-polish-profile.test.mjs': 6873,
  'tests/v2-polish-refusals.test.mjs': 24029,
  'tests/v2-privacy.test.mjs': 6390,
  'tests/visual-diff.test.mjs': 138,
  'tests/websocket.test.mjs': 944,
  'tests/worker-http.test.mjs': 680,
  'tests/browser/build-servers.test.mjs': 1562,
  'tests/browser/capture-suite.test.mjs': 13348,
  'tests/browser/component-first.test.mjs': 20171,
  'tests/browser/migration-acceptance.test.mjs': 27037,
  'tests/browser/migration-session.test.mjs': 29823,
  'tests/browser/migration-verify.test.mjs': 20899,
  'tests/browser/recorder.test.mjs': 3608,
  'tests/browser/scenario-checkpoints.test.mjs': 5719,
  'tests/browser/serviceworker.test.mjs': 10626,
  'tests/browser/websocket.test.mjs': 2301,
};

/** L1 — arquivos leves + v2-privacy + build-servers; migration-operations entra só pelo subconjunto. */
const L1 = [
  'tests/binding-suggestions.test.mjs',
  'tests/build-servers.test.mjs',
  'tests/disposition-diagnostic-codes.test.mjs',
  'tests/equivalence-values.test.mjs',
  'tests/equivalence.test.mjs',
  'tests/expected-differences.test.mjs',
  'tests/http-scenarios.test.mjs',
  'tests/mcp-server.test.mjs',
  'tests/migration-reference.test.mjs',
  'tests/migration-report.test.mjs',
  'tests/migration-scope-overlap.test.mjs',
  'tests/migration-scope.test.mjs',
  'tests/noise-suggestions.test.mjs',
  'tests/persistence-stability.test.mjs',
  'tests/platform-paths.test.mjs',
  'tests/privacy-policy.test.mjs',
  'tests/process-tree.test.mjs',
  'tests/public-io-boundary.test.mjs',
  'tests/public-io-conformance.test.mjs',
  'tests/review-regressions.test.mjs',
  'tests/scenario-bindings.test.mjs',
  'tests/security.test.mjs',
  'tests/serviceworker.test.mjs',
  'tests/state-claims.test.mjs',
  'tests/state-schema.test.mjs',
  'tests/unit-assertions.test.mjs',
  'tests/v2-envelope.test.mjs',
  'tests/v2-privacy.test.mjs',
  'tests/visual-diff.test.mjs',
  'tests/websocket.test.mjs',
  'tests/worker-http.test.mjs',
];

const OPERATIONS_FILE = 'tests/migration-operations.test.mjs';

/**
 * Subconjunto de migration-operations sem prepare/verify completo: parseMigrationPreparation,
 * as recusas que acontecem antes de reservar/executar (autorização, output inseguro, hash) —
 * todos os que a auditoria media < 2 s. O `--test-name-pattern` é global por invocação, por isso
 * este subconjunto roda como comando próprio.
 */
const L1_OPERATIONS = {
  file: OPERATIONS_FILE,
  namePattern: '^(parseMigrationPreparation accepts|prepareMigration and verifyMigration refuse|reserve refuses|verifyMigration refuses)',
};

/**
 * Complemento das linhas 96-133 (stale-evidence / preflight-only) — o buraco P1: roda
 * preflight/verify completos. Medição (auditoria + `PLAYWRIGHT_BROWSERS_PATH` vazio): os dois
 * testes PASSAM com e sem chromium (ambos aceitam INCONCLUSIVE e o STALE_EVIDENCE independe do
 * probe), logo não é necessária guarda `t.skip`, que só reduziria a garantia; o peso de
 * prepare/verify os coloca em L3, a camada serial dos fluxos completos.
 */
const L3_OPERATIONS = {
  file: OPERATIONS_FILE,
  namePattern: '^(verifyMigration with an unreadable preparation evidence root|preflight reports bounded status)',
};

/** L2 — integração sem fixture de browser e sem portas fixas; concorrência 2. */
const L2 = [
  'tests/api-first-persistence.test.mjs',
  'tests/artifact-lifecycle.test.mjs',
  'tests/characterization-exit-codes.test.mjs',
  'tests/characterization-profiles.test.mjs',
  'tests/characterization-verification-status.test.mjs',
  'tests/cli-json.test.mjs',
  'tests/managed-server.test.mjs',
  'tests/mcp-boundary.test.mjs',
  'tests/migration-session-update.test.mjs',
  'tests/migration-session.test.mjs',
  'tests/prepare-retry.test.mjs',
  'tests/project-checks.test.mjs',
  'tests/project-reset.test.mjs',
  'tests/session-scope-guard.test.mjs',
  'tests/state-capture.test.mjs',
  'tests/v2-commands.test.mjs',
  'tests/v2-polish-profile.test.mjs',
  'tests/v2-polish-refusals.test.mjs',
];

/** L3 — browser/pesados + o complemento de migration-operations. */
const L3 = [
  'tests/api-first-acceptance.test.mjs',
  'tests/browser/build-servers.test.mjs',
  'tests/browser/capture-suite.test.mjs',
  'tests/browser/component-first.test.mjs',
  'tests/browser/migration-acceptance.test.mjs',
  'tests/browser/migration-session.test.mjs',
  'tests/browser/migration-verify.test.mjs',
  'tests/browser/recorder.test.mjs',
  'tests/browser/scenario-checkpoints.test.mjs',
  'tests/browser/serviceworker.test.mjs',
  'tests/browser/websocket.test.mjs',
  'tests/characterization-privacy.test.mjs',
  'tests/v2-decisions.test.mjs',
  'tests/perf-browser-cleanup.test.mjs',
  'tests/perf-browser-reuse.test.mjs',
  'tests/v2-polish-comparisons.test.mjs',
];

/** Exclusive — serial; cada entrada carrega o motivo da exclusão dos grupos paralelos. */
const EXCLUSIVE = [];

/**
 * Namespace da lane paralela (cache de build): glob dinâmico para o manifesto continuar cobrindo
 * os arquivos enquanto a outra lane cria/edita. Motivo: edição concorrente na outra lane.
 */
const PARALLEL_LANE_PATTERN = /^tests\/cache-.*\.test\.mjs$/;
const PARALLEL_LANE_REASON = 'lane paralela (cache de build): edição concorrente na outra lane + tempo não medido — exclusive até medição';

const exclusiveFiles = onDisk => [
  ...EXCLUSIVE.map(item => item.path),
  ...onDisk.filter(path => PARALLEL_LANE_PATTERN.test(path)),
];

const reasonFor = (path, onDisk) =>
  EXCLUSIVE.find(item => item.path === path)?.reason
  ?? (PARALLEL_LANE_PATTERN.test(path) ? PARALLEL_LANE_REASON : undefined);

const listDir = dir => readdirSync(join(ROOT, dir), { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map(entry => `${dir}/${entry.name}`);

/** Exatamente o alvo do gate: tests/*.test.mjs + tests/browser/*.test.mjs. */
const onDisk = () => [...listDir('tests'), ...listDir('tests/browser')].sort();

/**
 * Camadas canônicas: arquivos inteiros (`files`) + recortes por nome (`subsets`). É a fonte única
 * tanto da execução (run-tests.mjs) quanto da checagem de cobertura/execução.
 */
const layersFor = onDiskFiles => ({
  l1: { files: L1, subsets: [L1_OPERATIONS] },
  l2: { files: L2, subsets: [] },
  l3: { files: L3, subsets: [L3_OPERATIONS] },
  exclusive: { files: exclusiveFiles(onDiskFiles), subsets: [] },
});

/**
 * Plano de execução de um grupo. `l1-operations` existe para o dev loop e roda só o recorte; as
 * camadas (l1/l2/l3/exclusive) rodam seus arquivos inteiros e, em seguida, seus recortes.
 */
const plan = name => {
  if (name === 'l1-operations') return { files: [], subsets: [L1_OPERATIONS] };
  if (name === 'l3-operations') return { files: [], subsets: [L3_OPERATIONS] };
  const layers = layersFor(onDisk());
  return layers[name];
};

/** Recorte por nome: cada `test(...)` do arquivo é capturado na própria declaração. */
const TEST_DECL = /(?:^|\n)[ \t]*(?:test|it)(?:\.\w+)?\s*\(\s*([`'"])([\s\S]*?)\1/g;

const testNamesOf = file => {
  const source = readFileSync(join(ROOT, file), 'utf8');
  return [...source.matchAll(TEST_DECL)].map(match => match[2]);
};

/** Testes que uma camada executa: arquivos inteiros + os que casam com cada `namePattern`. */
const selectedTests = layer => {
  const selected = new Map();
  for (const file of layer.files) selected.set(file, new Set(testNamesOf(file)));
  for (const subset of layer.subsets) {
    const pattern = new RegExp(subset.namePattern);
    const set = selected.get(subset.file) ?? new Set();
    for (const name of testNamesOf(subset.file)) if (pattern.test(name)) set.add(name);
    selected.set(subset.file, set);
  }
  return selected;
};

/** Camadas que executam um teste nomeado (arquivo inteiro ou recorte por nome). */
function owningLayers(onDiskFiles, file, name) {
  const layers = layersFor(onDiskFiles);
  const owners = [];
  for (const [layerName, layer] of Object.entries(layers)) {
    if (layer.files.includes(file)) { owners.push(layerName); continue; }
    if (layer.subsets.some(subset => subset.file === file && new RegExp(subset.namePattern).test(name))) owners.push(layerName);
  }
  return owners;
}

/**
 * Allowlist nomeada de skips: `{file, test, os, reason}`. Um skip fora dela falha o step em
 * qualquer SO (o runner em `scripts/run-tests.mjs` aplica). `os` é `process.platform` ou `any`.
 * Cobre apenas skips de plataforma declarados: os testes de POSIX/process-tree no Windows e os
 * que exigem symlink. Chromium/toolchain ausentes NÃO entram: o CI faz preflight de ambos e um
 * skip aí é regressão, não tolerância.
 */
const SKIP_ALLOWLIST = [
  {
    file: 'tests/process-tree.test.mjs',
    test: 'killTree on a process group terminates a grandchild tree',
    os: 'win32',
    reason: 'POSIX group semantics; Windows tree kill is covered by CI integration',
  },
  {
    file: 'tests/perf-browser-cleanup.test.mjs',
    test: 'aborting a suite mid-capture closes its browser and leaves no orphan Chromium process',
    os: 'win32',
    reason: 'POSIX process-tree semantics; Windows tree kill is covered by CI integration',
  },
  {
    file: 'tests/perf-browser-cleanup.test.mjs',
    test: 'a hard crash during a capture leaves no orphan Chromium process behind',
    os: 'win32',
    reason: 'POSIX process-tree semantics; Windows tree kill is covered by CI integration',
  },
  {
    file: 'tests/mcp-boundary.test.mjs',
    test: 'mcp refuses config and preparation symlinks that resolve into private storage',
    os: 'win32',
    reason: 'symlinks unavailable on this host',
  },
  {
    file: 'tests/mcp-boundary.test.mjs',
    test: 'mcp refuses the real spelling of a private file behind a symlinked state dir',
    os: 'win32',
    reason: 'symlinks unavailable on this host',
  },
];

/**
 * Mapa dos 13 invariantes-contrato (kill switch). A camada de cada teste é DERIVADA do manifesto
 * (`owningLayers`), então o mapa não pode divergir da partição: `check` falha se um teste não
 * existir, não tiver exatamente uma camada, ou se `tests/INVARIANTS.md` não bater com este mapa.
 *
 * Nota de restauração: o invariante 11 (fronteira de private-root na ingestão) era dono do
 * `tests/har-import-boundary.test.mjs` (comando `import-har`, morto no kill switch §8.2). A
 * fronteira sobrevive no canal MCP (`packages/mcp-server/src/public-io.ts`, coberto por
 * mcp-boundary) e no leitor CLI (`packages/cli/src/assistant-files.ts`, canal de ingestão das rotas
 * v2). O leitor CLI e o binding dev/ino de `openPublicFile` foram restaurados em
 * `tests/public-io-boundary.test.mjs` (L1), pois a remoção os tinha deixado sem dono.
 */
const INVARIANTS = [
  {
    id: 'INV-01', behavior: 'matriz decision × exit (COMPLETE/0, REPAIR/4, FIX_ENVIRONMENT/5)',
    tests: [
      { file: 'tests/v2-decisions.test.mjs', name: 'an equivalent candidate completes the session: decision COMPLETE, PASS report, exit 0' },
      { file: 'tests/v2-decisions.test.mjs', name: 'a target behavior divergence decides REPAIR_IMPLEMENTATION with a FAIL report and exit 4' },
      { file: 'tests/v2-decisions.test.mjs', name: 'an unsatisfied scenario completion decides FIX_ENVIRONMENT: INCONCLUSIVE, never a pass, exit 5' },
    ],
  },
  {
    id: 'INV-02', behavior: 'precedência de exit codes (erro < stop < avaliação < sucesso)',
    tests: [
      { file: 'tests/v2-envelope.test.mjs', name: 'exit codes follow the documented priority: processing error < session stop < evaluation < success' },
      { file: 'tests/project-checks.test.mjs', name: 'a native check report maps onto the v2 envelope exit codes (FAIL 4, INCONCLUSIVE 5)' },
    ],
  },
  {
    id: 'INV-03', behavior: 'REFUSED_SCOPE → exit 3 sem gastar attempt',
    tests: [
      { file: 'tests/v2-commands.test.mjs', name: 'a workspace outside the authorized scope refuses verify with exit 3 and no attempt spent' },
      { file: 'tests/v2-commands.test.mjs', name: 'verify refuses before spending an attempt when the session or the authorization is missing' },
      { file: 'tests/session-scope-guard.test.mjs', name: 'an out-of-scope target edit refuses the reference update before execution and stays reported by verification' },
    ],
  },
  {
    id: 'INV-04', behavior: 'budgets/stop → exit 3 com diagnóstico catalogado',
    tests: [
      { file: 'tests/v2-polish-refusals.test.mjs', name: 'a budget stop refuses verify with a catalogued diagnostic and exit 3 (A9)' },
      { file: 'tests/v2-polish-refusals.test.mjs', name: 'an exit-3 stop always carries its catalog diagnostic, never diagnostics: [] (A9)' },
    ],
  },
  {
    id: 'INV-05', behavior: 'disclosures de privacidade não mudam status/exit',
    tests: [
      { file: 'tests/characterization-privacy.test.mjs', name: '--allow-insecure-private-store stamps the report degraded without changing its status or exit code' },
      { file: 'tests/characterization-privacy.test.mjs', name: 'a PASS report may carry both disclosures without being downgraded' },
      { file: 'tests/privacy-policy.test.mjs', name: 'PASS may carry privacy disclosures; other diagnostics still contradict PASS' },
    ],
  },
  {
    id: 'INV-06', behavior: 'recusa fora do profile standard, sem handover',
    tests: [
      { file: 'tests/v2-commands.test.mjs', name: 'outside profile standard the v2 flow refuses with exit 1 and recommends nothing' },
      { file: 'tests/v2-polish-profile.test.mjs', name: 'doctor reports a missing standard profile as a finding, never as a failure' },
    ],
  },
  {
    id: 'INV-07', behavior: 'STALE_EVIDENCE nunca vira PASS',
    tests: [
      { file: 'tests/migration-operations.test.mjs', name: 'verifyMigration with an unreadable preparation evidence root stays inconclusive with stale-evidence diagnostics' },
      { file: 'tests/state-capture.test.mjs', name: 'source state that changes after preparation is refused as stale evidence' },
      { file: 'tests/migration-reference.test.mjs', name: 'verification separates stale evaluation inputs from expected candidate changes' },
    ],
  },
  {
    id: 'INV-08', behavior: 'envelope --json é o objeto do engine; texto ≠ JSON',
    tests: [
      { file: 'tests/cli-json.test.mjs', name: '--json prints exactly one envelope and text mode stays human-readable' },
      { file: 'tests/v2-commands.test.mjs', name: 'text mode prints one human summary on stdout and keeps diagnostics on stderr' },
      { file: 'tests/v2-commands.test.mjs', name: 'a completed migration flows through the envelope end to end' },
    ],
  },
  {
    id: 'INV-09', behavior: 'identidade/gerações/attempts preservados em reference/update',
    tests: [
      { file: 'tests/migration-session-update.test.mjs', name: 'session reference update preserves identity, attempts and budgets across coverage, binding and owner-approved changes' },
      { file: 'tests/migration-session-update.test.mjs', name: 'generations chain is validated on every load; corruption throws and deletion falls back to generation zero' },
      { file: 'tests/migration-reference.test.mjs', name: 'a new reference version records lineage and needs an owner decision only when criteria weaken' },
    ],
  },
  {
    id: 'INV-10', behavior: 'ponta-a-ponta com regressão controlada e recuperação',
    tests: [
      { file: 'tests/browser/migration-verify.test.mjs', name: 'validation-first example prepares a reference, verifies PASS, fails the documented regression and recovers' },
      { file: 'tests/browser/migration-acceptance.test.mjs', name: 'acceptance: one standard session repairs value, validation and navigation defects across a mid-flow reference refresh' },
      { file: 'tests/api-first-acceptance.test.mjs', name: 'api-first acceptance: prepare and the untouched candidate verify PASS' },
    ],
  },
  {
    id: 'INV-11', behavior: 'fronteira de private-root na ingestão (MCP + leitor CLI; har-import morreu)',
    tests: [
      { file: 'tests/mcp-boundary.test.mjs', name: 'mcp refuses config and preparation symlinks that resolve into private storage' },
      { file: 'tests/mcp-boundary.test.mjs', name: 'mcp refuses private state-dir paths under env overrides and windows separators' },
      { file: 'tests/mcp-boundary.test.mjs', name: 'mcp refuses the real spelling of a private file behind a symlinked state dir' },
      { file: 'tests/public-io-boundary.test.mjs', name: 'cli public reader refuses private roots: literal, symlinked and state-dir override' },
      { file: 'tests/public-io-boundary.test.mjs', name: 'public reads bind the opened object to the validated identity and refuse swaps' },
    ],
  },
  {
    id: 'INV-12', behavior: 'rotação de chave/anchor/symlink/audit chain',
    tests: [
      { file: 'tests/artifact-lifecycle.test.mjs', name: 'key rotation re-seals raw, retains keys and refuses unsafe automatic pruning' },
      { file: 'tests/artifact-lifecycle.test.mjs', name: 'rotation preserves archived copies and backup root cannot equal the public root' },
      { file: 'tests/artifact-lifecycle.test.mjs', name: 'external audit anchoring appends, chains and refuses private-domain or symlinked targets' },
      { file: 'tests/artifact-lifecycle.test.mjs', name: 'concurrent anchors refuse overlapping writers and retries preserve continuity' },
    ],
  },
  {
    id: 'INV-13', behavior: 'matriz de combinações do envelope (trios válidos/inválidos)',
    tests: [
      { file: 'tests/v2-envelope.test.mjs', name: 'the envelope combination table is exactly the documented set of valid trios' },
      { file: 'tests/v2-envelope.test.mjs', name: 'trios outside the table are refused instead of silently accepted' },
    ],
  },
];

const INVARIANTS_DOC = 'tests/INVARIANTS.md';

/** Repo-relative spelling of a path as the reporter reports it (absolute, OS separators). */
const repoPath = file => relative(ROOT, file).split('\\').join('/');

/** True when a skip event matches a declared allowlist entry for the running OS. */
const skipIsAllowed = (skip, os) => SKIP_ALLOWLIST.some(entry => entry.file === repoPath(skip.file)
  && entry.test === skip.name && (entry.os === 'any' || entry.os === os) && entry.reason === skip.skip);

function renderInvariants(onDiskFiles) {
  const lines = [
    '# Invariantes-contrato (kill switch)',
    '',
    'Mapa comportamento → teste atual → camada que o executa. Gerado por',
    '`node tests/test-groups.mjs invariants --write` e validado por',
    '`node tests/test-groups.mjs check` (a camada é derivada do manifesto, não escrita à mão).',
    '',
    '| id | comportamento | testes (arquivo :: teste) e camada |',
    '|----|---------------|-------------------------------------|',
  ];
  for (const invariant of INVARIANTS) {
    const cells = invariant.tests.map(({ file, name }) => {
      const owners = owningLayers(onDiskFiles, file, name);
      return `${file} :: \`${name}\` (${owners.join('+') || 'SEM CAMADA'})`;
    });
    lines.push(`| ${invariant.id} | ${invariant.behavior} | ${cells.join('<br>')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

const seconds = ms => `${(ms / 1000).toFixed(1)} s`;
const sumTimings = files => {
  const known = files.filter(path => TIMINGS_MS[path] !== undefined);
  const unknown = files.filter(path => TIMINGS_MS[path] === undefined);
  const total = known.reduce((acc, path) => acc + TIMINGS_MS[path], 0);
  return { total, unknown };
};

/**
 * Prova de EXECUÇÃO, não de nomes: além da partição de arquivos, exige que todo `test()` de um
 * arquivo recortado por nome seja selecionado por exatamente uma camada.
 */
function check() {
  const disk = onDisk();
  const layers = layersFor(disk);
  const problems = [];

  // 1. Partição de arquivos: cada arquivo do disco é dono de exatamente uma camada — inteiro
  //    (files) ou recortado por nome (subsets) —, nunca dos dois modos nem de duas camadas.
  const wholeOwners = new Map();
  const subsetOwners = new Map();
  for (const [name, layer] of Object.entries(layers)) {
    for (const file of layer.files) wholeOwners.set(file, [...(wholeOwners.get(file) ?? []), name]);
    for (const subset of layer.subsets) subsetOwners.set(subset.file, [...(subsetOwners.get(subset.file) ?? []), name]);
  }
  for (const [file, owners] of wholeOwners) {
    if (owners.length > 1) problems.push(`arquivo inteiro em mais de uma camada: ${file} (${owners.join('+')})`);
    if (subsetOwners.has(file)) problems.push(`arquivo inteiro e recortado por nome: ${file}`);
    if (!disk.includes(file)) problems.push(`fora do disco: ${file}`);
  }
  for (const file of subsetOwners.keys()) {
    if (!disk.includes(file)) problems.push(`recorte fora do disco: ${file}`);
  }
  for (const file of disk) {
    if (!wholeOwners.has(file) && !subsetOwners.has(file)) problems.push(`sem camada: ${file}`);
  }

  // 2. Execução dos recortes: todo test() do arquivo recortado casa com exatamente uma camada.
  const testOwners = new Map();
  for (const [name, layer] of Object.entries(layers)) {
    for (const [file, names] of selectedTests(layer)) {
      for (const testName of names) {
        const key = `${file}\u0000${testName}`;
        testOwners.set(key, [...(testOwners.get(key) ?? []), name]);
      }
    }
  }
  for (const file of subsetOwners.keys()) {
    const names = testNamesOf(file);
    if (!names.length) problems.push(`recorte sem test() parseável: ${file}`);
    for (const testName of names) {
      const owners = testOwners.get(`${file}\u0000${testName}`) ?? [];
      if (!owners.length) problems.push(`test() não executado por nenhuma camada: ${file} :: ${testName}`);
      if (owners.length > 1) problems.push(`test() executado por mais de uma camada: ${file} :: ${testName} (${owners.join('+')})`);
    }
  }
  // Um namePattern que não casa com nada é um recorte quebrado.
  for (const layer of Object.values(layers)) {
    for (const subset of layer.subsets) {
      const pattern = new RegExp(subset.namePattern);
      if (!testNamesOf(subset.file).some(name => pattern.test(name))) problems.push(`namePattern não casa nenhum teste: ${subset.file} ${subset.namePattern}`);
    }
  }

  // 3. Allowlist de skips: cada entrada tem de apontar para um teste real.
  for (const entry of SKIP_ALLOWLIST) {
    if (!disk.includes(entry.file)) problems.push(`allowlist aponta para arquivo fora do disco: ${entry.file}`);
    else if (!testNamesOf(entry.file).includes(entry.test)) problems.push(`allowlist aponta para teste inexistente: ${entry.file} :: ${entry.test}`);
    if (!['win32', 'linux', 'darwin', 'any'].includes(entry.os)) problems.push(`allowlist com SO inválido: ${entry.os} (${entry.file})`);
  }

  // 4. Mapa dos 13 invariantes: cada teste existe e tem exatamente uma camada que o executa.
  if (INVARIANTS.length !== 13) problems.push(`mapa de invariantes tem ${INVARIANTS.length} entradas (esperado 13)`);
  for (const invariant of INVARIANTS) {
    for (const { file, name } of invariant.tests) {
      if (!disk.includes(file)) { problems.push(`${invariant.id}: arquivo fora do disco: ${file}`); continue; }
      if (!testNamesOf(file).includes(name)) problems.push(`${invariant.id}: teste inexistente: ${file} :: ${name}`);
      const owners = owningLayers(disk, file, name);
      if (owners.length !== 1) problems.push(`${invariant.id}: ${owners.length} camadas executam ${file} :: ${name} (${owners.join('+') || 'nenhuma'})`);
    }
  }
  const expectedDoc = renderInvariants(disk);
  let actualDoc;
  try { actualDoc = readFileSync(join(ROOT, INVARIANTS_DOC), 'utf8'); }
  catch { problems.push(`${INVARIANTS_DOC} ausente; rode 'node tests/test-groups.mjs invariants --write'`); }
  if (actualDoc !== undefined && actualDoc !== expectedDoc) problems.push(`${INVARIANTS_DOC} divergente do mapa; rode 'node tests/test-groups.mjs invariants --write'`);

  // Relatório de tempos por camada.
  console.error('camada      arquivos  tempo medido (auditoria 2026-10-03)');
  for (const [name, layer] of Object.entries(layers)) {
    const files = [...new Set([...layer.files, ...layer.subsets.map(subset => subset.file)])];
    const { total, unknown } = sumTimings(files);
    const note = unknown.length ? ` + ${unknown.length} sem medição` : '';
    console.error(`${name.padEnd(11)} ${String(files.length).padStart(7)}  ${seconds(total)}${note}`);
  }
  const all = [...new Set([...wholeOwners.keys(), ...subsetOwners.keys()])];
  const { total, unknown } = sumTimings(all);
  console.error(`total      ${String(all.length).padStart(8)}  ${seconds(total)}${unknown.length ? ` + ${unknown.length} sem medição` : ''}`);
  console.error(`invariantes: ${INVARIANTS.length}; skips declarados: ${SKIP_ALLOWLIST.length}`);
  if (unknown.length) console.error(`sem medição de tempo: ${unknown.join(', ')}`);

  if (problems.length) {
    for (const problem of problems) console.error(`FALHA: ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.error(`cobertura/execução exatas: ${disk.length} arquivos, ${testOwners.size} test() = união de ${Object.keys(layers).length} camadas, sem sobra e sem duplicata`);
}

function runOperationsSubset(label, subset) {
  const argv = [process.execPath, '--test', '--test-concurrency=1',
    `--test-name-pattern=${subset.namePattern}`, subset.file];
  console.error(`${label}: ${argv.slice(1).join(' ')}`);
  const result = spawnSync(argv[0], argv.slice(1), { cwd: ROOT, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

function main() {
  const command = process.argv[2];
  const disk = onDisk();
  const layers = layersFor(disk);
  if (command === 'check') return check();
  if (command === 'l1-operations') return runOperationsSubset('l1-operations', L1_OPERATIONS);
  if (command === 'l3-operations') return runOperationsSubset('l3-operations', L3_OPERATIONS);
  if (command === 'invariants') {
    const text = renderInvariants(disk);
    if (process.argv[3] === '--write') { writeFileSync(join(ROOT, INVARIANTS_DOC), text); console.error(`escrito ${INVARIANTS_DOC}`); }
    else process.stdout.write(text);
    return;
  }
  if (command && layers[command]) {
    // Comando imprime só os arquivos inteiros (o recorte roda por `l1-operations`/run-tests).
    return void console.log(layers[command].files.join(' '));
  }
  if (command === 'all') return void console.log(disk.join(' '));
  console.error('uso: node tests/test-groups.mjs l1|l2|l3|exclusive|all|l1-operations|l3-operations|check|invariants [--write]');
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export { L1, L1_OPERATIONS, L2, L3, L3_OPERATIONS, EXCLUSIVE, TIMINGS_MS, SKIP_ALLOWLIST, INVARIANTS, layersFor, plan, onDisk, reasonFor, skipIsAllowed, ROOT };
