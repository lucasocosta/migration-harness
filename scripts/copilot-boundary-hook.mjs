#!/usr/bin/env node
// PreToolUse boundary hook for the Copilot migration agents.
//
// Converts part of the AGENTS.md brief-only policy into a mechanical refusal:
// the hook derives the boundary from the harness-issued brief and denies tool
// calls that leave it. It is defense in depth, not isolation. Same-UID access
// outside the agent's tool calls is not prevented, and the harness remains the
// only oracle: nothing here certifies a candidate.
//
// Contract: reads a PreToolUse payload on stdin, prints a deny decision on
// stdout, or prints nothing to leave the normal approval flow untouched.
// Unreadable input, unknown phase or a missing brief deny (fail closed).
//
// Configuration (set by the agent file, not by the model):
//   HARNESS_PHASE       'preparation' | 'transformation'   (required)
//   HARNESS_BRIEF       path to the issued brief JSON      (transformation)
//   HARNESS_REPO_ROOT   harness repository root            (default: cwd)
//   HARNESS_HOOK_LOG    JSONL decision log                 (default: artifacts/copilot-boundary.log)
// When HARNESS_BRIEF is absent, the brief path is read from the first line of
// `.harness-brief-path` in the repository root.

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, relative, isAbsolute, join, dirname, sep } from 'node:path';

const MAX_STDIN_BYTES = 4_000_000;
const repoRoot = resolve(process.env.HARNESS_REPO_ROOT ?? process.cwd());
const phase = process.env.HARNESS_PHASE ?? '';
const logPath = resolve(repoRoot, process.env.HARNESS_HOOK_LOG ?? 'artifacts/copilot-boundary.log');

const privateStateRoot = process.env.MIGRATION_HARNESS_STATE_DIR
  ? resolve(process.env.MIGRATION_HARNESS_STATE_DIR)
  : resolve(homedir(), '.local', 'state', 'migration-harness');
const SECRET = /(?:^|[/\\])(?:\.env(?:\.[\w-]+)?|\.npmrc|\.netrc|id_rsa|id_ed25519|credentials(?:\.json)?)$|\.(?:pem|key|p12|pfx)$/i;
// Actual CLI subcommand names; oracle and raw-domain acts belong to the harness operator.
const ORACLE_COMMANDS = /(?:^|[\s;|&])(?:synthesize|review-contract|approve-contract|trace|import-openapi|import-test-evidence|sanitize-trace|purge-raw|rotate-raw-key|anchor-audit)(?:$|[\s;|&])/;
// Global git options (-C <path>, --git-dir=...) may precede the subcommand.
const GIT_PUBLISH = /(?:^|[\s;|&])git\s+(?:(?:-[cC]\s+\S+|--\S+)\s+)*(?:commit|push|merge|rebase|reset|checkout|clean|switch|tag|am|cherry-pick)(?:$|\s)/;

const decide = (reason, extra = {}) => {
  log({ decision: 'deny', reason, ...extra });
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
};

const allow = extra => { log({ decision: 'pass', ...extra }); process.exit(0); };

function log(entry) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), phase, ...entry })}\n`);
  } catch { /* the boundary decision must not depend on log availability */ }
}

function readStdin() {
  try {
    const raw = readFileSync(0);
    if (raw.byteLength > MAX_STDIN_BYTES) return undefined;
    return JSON.parse(raw.toString('utf8'));
  } catch { return undefined; }
}

// Every string in an unknown tool_input shape is a boundary candidate: tool
// schemas differ per tool and new tools must not silently escape the check.
function strings(value, out = [], depth = 0) {
  if (depth > 8 || out.length > 5000) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out, depth + 1);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item, out, depth + 1);
  return out;
}

const looksLikePath = value =>
  value.length > 0 && value.length <= 4096 && (value.includes('/') || value.includes('\\') || /\.[A-Za-z0-9]{1,8}$/.test(value));

function normalize(value) {
  let text = value.trim().replace(/^file:\/\//, '');
  try { text = decodeURIComponent(text); } catch { /* keep the raw form */ }
  if (text.startsWith('~')) text = join(homedir(), text.slice(1));
  return resolve(repoRoot, text);
}

const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};

// Refusals that hold in both phases and for every tool.
function alwaysForbidden(raw, path) {
  if (/(?:^|[/\\])\.migration-private(?:[/\\]|$)/.test(raw)) return 'caminho do domínio privado (.migration-private)';
  if (inside(privateStateRoot, path) || /state[/\\]migration-harness[/\\]/.test(raw)) return 'raiz privada de artefatos do harness';
  if (SECRET.test(raw)) return 'arquivo de segredo/credencial';
  return undefined;
}

function readBriefBoundary() {
  let briefPath = process.env.HARNESS_BRIEF;
  if (!briefPath) {
    try { briefPath = readFileSync(resolve(repoRoot, '.harness-brief-path'), 'utf8').split('\n')[0].trim(); } catch { /* reported below */ }
  }
  if (!briefPath) return { error: 'nenhum brief configurado (HARNESS_BRIEF ou .harness-brief-path)' };
  const resolved = resolve(repoRoot, briefPath);
  let brief;
  try { brief = JSON.parse(readFileSync(resolved, 'utf8')); } catch { return { error: `brief ilegível em ${resolved}` }; }
  const payload = brief?.brief ?? brief;
  const command = typeof payload?.submission?.command === 'string' ? payload.submission.command : '';
  const flag = name => {
    const match = command.match(new RegExp(`--${name}\\s+(?:'((?:[^']|'\\\\'')*)'|([^\\s]+))`));
    return match ? (match[1] ?? match[2]).replace(/'\\''/g, "'") : undefined;
  };
  const candidateRoot = flag('candidate-root');
  const artifactRoot = flag('artifact-root');
  if (!Array.isArray(payload?.allowedFiles) || !candidateRoot || !artifactRoot) return { error: 'brief sem allowedFiles/candidate-root/artifact-root utilizáveis' };
  return {
    briefPath: resolved,
    candidateRoot: resolve(repoRoot, candidateRoot),
    artifactRoot: resolve(repoRoot, artifactRoot),
    allowed: payload.allowedFiles.map(file => resolve(repoRoot, candidateRoot, file.path)),
    context: (Array.isArray(payload.contextFiles) ? payload.contextFiles : []).map(path => resolve(repoRoot, path)),
  };
}

const payload = readStdin();
if (!payload) decide('Hook de fronteira não conseguiu ler a chamada de ferramenta; recusa fail-closed.');
if (phase !== 'preparation' && phase !== 'transformation') {
  decide('HARNESS_PHASE ausente ou inválido: o agente precisa declarar preparation ou transformation.');
}

const tool = String(payload.tool_name ?? '');
const values = strings(payload.tool_input);
const paths = values.filter(looksLikePath).map(raw => ({ raw, path: normalize(raw) }));
const isWrite = /(?:editFiles|createFile|createDirectory|editNotebook|applyPatch|writeFile)$/i.test(tool);
const isExecute = /(?:runInTerminal|createAndRunTask|runNotebookCell|runCommand)$/i.test(tool);
const commands = isExecute ? values : [];

for (const { raw, path } of paths) {
  const reason = alwaysForbidden(raw, path);
  if (reason) decide(`Recusado: ${raw} — ${reason}. Traces e chaves não existem para o agente (AGENTS.md §4/§7).`, { tool, path: raw });
}
for (const command of commands) {
  for (const token of command.split(/[\s'"();|&]+/).filter(looksLikePath)) {
    const reason = alwaysForbidden(token, normalize(token));
    if (reason) decide(`Comando recusado: referencia ${token} — ${reason}.`, { tool, command });
  }
}

if (phase === 'preparation') {
  const tracking = resolve(repoRoot, process.env.HARNESS_TRACKING_DIR ?? 'migrations');
  if (isWrite) {
    for (const { raw, path } of paths) {
      if (!inside(tracking, path)) {
        decide(`Escrita recusada em ${raw}: a preparação só escreve em ${relative(repoRoot, tracking)}/ (inventário e propostas). Candidatos, Angular e harness são somente leitura nesta fase.`, { tool, path: raw });
      }
    }
  }
  if (isExecute) {
    decide('A preparação não executa comandos: o responsável humano roda instalações, servidores e comandos do harness (COPILOT-MIGRATION.md §3).', { tool });
  }
  allow({ tool });
}

// Transformation: brief-only.
const boundary = readBriefBoundary();
if (boundary.error) {
  decide(`Fase de transformação sem fronteira emitida: ${boundary.error}. Sem brief não há escopo; pare e peça um brief ao responsável.`, { tool });
}

if (isWrite) {
  for (const { raw, path } of paths) {
    if (inside(boundary.candidateRoot, path)) {
      decide(`Escrita direta recusada em ${raw}: apply-patch é o dono das escritas nos candidatos. Produza submission.json em ${relative(repoRoot, boundary.artifactRoot)} (AGENTS.md §3).`, { tool, path: raw });
    }
    if (!(inside(boundary.artifactRoot, path) && /\.json$/i.test(path))) {
      decide(`Escrita recusada em ${raw}: nesta fase o único arquivo gravável é um JSON de submissão dentro de ${relative(repoRoot, boundary.artifactRoot)}.`, { tool, path: raw });
    }
  }
}

if (!isWrite && !isExecute) {
  const readable = [boundary.briefPath, resolve(repoRoot, 'AGENTS.md'), resolve(repoRoot, 'docs/COPILOT-MIGRATION.md'), ...boundary.allowed, ...boundary.context];
  const readableRoots = [boundary.artifactRoot, resolve(repoRoot, 'docs/templates')];
  for (const { raw, path } of paths) {
    if (readable.includes(path) || readableRoots.some(root => inside(root, path))) continue;
    const detail = inside(boundary.candidateRoot, path)
      ? 'está no repositório de destino, mas fora de allowedFiles/contextFiles'
      : 'está fora do brief';
    decide(`Leitura recusada: ${raw} ${detail}. Pare e peça a inclusão do arquivo em contextFiles em vez de ampliar o escopo (AGENTS.md §2/§8).`, { tool, path: raw });
  }
}

for (const command of commands) {
  if (ORACLE_COMMANDS.test(command)) {
    decide('Comando recusado: sintetizar, revisar ou aprovar contratos, capturar traces, importar evidências e operar chaves/auditoria são atos do oráculo e do responsável humano, nunca do worker (AGENTS.md §1/§4).', { tool, command });
  }
  if (GIT_PUBLISH.test(command)) {
    decide('Comando git recusado: commit, merge, push e reescrita de histórico dependem de autorização humana explícita (COPILOT-MIGRATION.md §7).', { tool, command });
  }
}

allow({ tool });
