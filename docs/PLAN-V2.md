# Plano migration-harness v2

> Status: proposta aprovada para execução. Data: 2026-10-03.
> Origem: auditoria de código (dead code/complexidade), auditoria de documentação e
> validação de arquitetura independente. Premissa central: **reescrever a interface
> operacional e as fronteiras duplicadas; preservar o núcleo de validação** até que o
> substituto demonstre paridade — sobretudo em falhas, inconclusivos e privacidade.
> Migração incremental, não big-bang.

## 1. Diagnóstico consolidado

### 1.1 Por que é lento
- `verify-migration` recaptura a suíte inteira a cada execução: `sourceRuns` capturas de
  source + 1 captura de target por cenário, serialmente (`engine/capture-suite.ts:81-106`),
  mais rebuild dos dois lados (`engine/build-servers.ts:377-386`).
- `sourceRuns` pesa também na verificação, não só na preparação.
- Não há fast path incremental. A referência preparada é reutilizada para confronto, mas
  não evita reexecução de source.
- `verifyMigration` (`engine/migration-operations.ts:253`) tem 215 LOC e faz verificação de
  referência antes, no meio e ao final, além de coletas novas — leituras intermediárias
  redundantes dentro da mesma fase.

### 1.2 Por que a IA não consegue usar
- 26 comandos CLI; `--help` existe só em 6 (`trace --help` → `Unknown option`, exit 1).
- Leitura obrigatória de ~132–175 KB antes da 1ª edição (AGENTS.md exige RFC+STATUS+PLAN).
- Contradições que travam o agente: "standard é proposto" (USAGE.md:24,580) × implementado
  (AGENTS.md:10); "Cinema pendente" (USAGE:159) × PASS (STATUS:15).
- Sem quickstart executável, sem árvore de comandos, sem referência de `MigrationConfig`,
  sem tabela `código → causa → ação`. Protocolo de iteração duplicado em 5 documentos.
- Flags mudam de semântica conforme perfil (`verify-migration` aceita `--preparation` no
  restricted e recusa no standard) sem tornar isso visível na invocação.
- Erros não-código viram `INVALID_MIGRATION_INPUT_OR_OUTPUT` (`cli/migration.ts:108-110`) —
  diagnóstico apagado.

### 1.3 Por que quebra/assusta no Windows
- Exemplos 100% bash; `MigrationPathSchema` rejeita `\`; risco CRLF↔`beforeHash` documentado
  só em OS-PORTABILITY.md; privacidade exige `--allow-insecure-private-store` (DEGRADED).
- O essencial já funciona (CI multi-OS existe); a documentação lê como "ainda quebrado"
  porque mistura diagnóstico histórico com estado atual.

### 1.4 Por que a documentação está presa no passado
- ~45–50% do corpus é histórico datado (VALIDATION.md 48.8 KB + AUDIT/REVIEWS/PUBLICATION/
  CINEMA/MCP-EVIDENCE ≈ 92 KB de arquivo), não instrução.
- `llm-wiki/` (681 KB) era paralelo, órfão e não rastreado pelo Git — **REMOVIDO por decisão do dono (2026-10-04)**: era um teste de outro projeto, nunca fez parte do corpus oficial.
- RFC v0.2/v0.3 misturados; package.json `0.2.1` vs docs "v0.3"; comandos citados não
  existem mais; STATUS "Updated" com data interna posterior.

## 2. O que é núcleo de valor (preservar) vs burocracia acidental (remover)

### 2.1 Preservar — é a promessa do produto
| Mecanismo | Por quê |
|---|---|
| Store privado + projeções públicas | Privacidade de traces; acesso mediado |
| Fingerprints referência/candidato/build/evidência | Vincula resultado aos bytes executados |
| Histórico de sessão + budgets | Continuidade após crash; evita loops/custos; sem reset silencioso |
| Briefs + `beforeHash` (perfil restricted) | Protege aplicação de patch contra baseline obsoleta |
| Pseudonimização + screening | Pontos de vazamento distintos; não são redundantes |
| Estado `INCONCLUSIVE` | Evidência incompleta nunca vira PASS |
| Critérios versionados + decisão do dono para enfraquecer | Independência: o agente não altera critério em reparo comum |

### 2.2 Remover / consolidar — burocracia acidental
| Item | Evidência | Ação |
|---|---|---|
| 15 pacotes | 37–102 LOC em transformation-planner/contract-review/trace-sanitizer | 3–5 unidades de distribuição |
| 615 LOC de tipos à mão sombreando zod | `core/{scenario,trace-events,behavior-contract,...}.ts` | Schema = fonte única; tipos inferidos |
| 2 modelos de resultado | `GateResult` vs `MigrationReport` | **Fechado na F4b:** `GateResult`/`evaluateGates` removidos (zero consumidores de produção); `MigrationReport` é o agregado único |
| IO público duplicado CLI↔MCP | `mcp-server/public-io.ts` "Mirrors `cli/assistant-files.ts`" | **FECHADO (2026-10-04):** política comum parametrizada em `core/public-surface` — união das garantias aplicada aos dois canais (CLI ganhou normalização de separadores, vocabulário completo de marcadores e reconferência de domínio público no open); diferenças legítimas (raízes configuráveis do store, vocabulário de recusa) viraram parâmetros; matriz de conformidade única roda contra os dois adapters |
| `digest` copiado 7× / 11 closures de "está dentro de" | engine/* | Usar `core/platform-paths.ts` |
| 3 matchers de rota `:param` | core/normalization.ts ×2 × contract-synthesizer | 1 implementação |
| Código morto | `DockerSandbox`, `MigrationEngineStateMachine`, `isApiScenario`, adaptadores de gate fora do pipeline, `policy.visual.masks`/`pixelThreshold` | Remover do caminho principal (adaptadores: fora do barrel) |
| Briefs/JSON-patch no fluxo standard | -- | Standard edita direto; restricted fica em namespace de compatibilidade |

## 3. CLI v2 — seis comandos, um ciclo óbvio

```
init → doctor → prepare → (agente edita) → verify → [reference | status]
```

| Comando | Função |
|---|---|
| `init` | Gera configuração mínima e aponta decisões faltantes. Não autoriza nada. |
| `doctor` | Valida schema, permissões, browser, comandos e capacidades do ambiente **antes** de gastar tentativa. |
| `prepare` | Estabelece referência e abre sessão numa operação retomável. Elimina `start` separado do fluxo normal. |
| `verify` | Sessão é a única autoridade para referência/output. Modo completo é padrão. |
| `status` | Estado, validade do último resultado, orçamento, bloqueios e **próxima ação**. |
| `reference` | Propõe/adota mudanças versionadas; classifica enfraquecimento; exige decisão apropriada. |

- `repair` **não é comando**: é trabalho do agente entre verificações.
- Perfil restricted vira `migrate-compat` (namespace/executor separado), fora do tutorial principal.

### 3.1 Contrato uniforme (o que torna "muito claro" para IA)
- Entrada: JSON versionado por arquivo ou stdin. Flags só para seleção/conveniência.
- Modo agente: **stdout = um envelope JSON**; progresso/logs seguros em stderr.
- Envelope: `schemaVersion`, `operation`, `operationStatus`, `sessionId`, `runId`,
  `decision`, `report`, `diagnostics`, `nextActions`.
- Sucesso da operação ≠ resultado comportamental ≠ decisão da sessão (separados no envelope).
- Diagnóstico: `code`, `category`, `retryable`, `fieldPath` seguro, ação recomendada.
  Sem stack/payload bruto. Catálogo único `código → causa → ação`.
- `nextActions`: operação + argumentos estruturados, pré-condições, aprovação necessária —
  nunca shell arbitrário derivado de runtime.
- **Tabela de combinações válidas** para `{operationStatus, decision, outcome}` (não três
  campos livres): `operationStatus` = processou/recusou/falhou operacionalmente; `outcome` =
  PASS/FAIL/INCONCLUSIVE, ausente sem avaliação; `decision` = disposição da sessão, nunca
  inferida só de `outcome`. Exit codes mantêm compatibilidade: `1` erro de processamento;
  `3` recusa/parada da sessão prevalece mesmo com relatório PASS; `4/5` avaliação
  FAIL/INCONCLUSIVE só sem parada prioritária; `0` sucesso da operação (doctor/status não
  aprovam migração). Gerar testes da tabela; nunca mudar exit codes incidentalmente.
- **Idempotência por chave de requisição** (definir antes de implementar): mesma chave +
  pedido normalizado igual → replay do resultado persistido (indicado, com validade atual
  separada — PASS antigo nunca vira PASS do workspace alterado); mesma chave + pedido
  diferente → conflito estruturado; em execução → apontar `status`; interrupção → apontar
  recuperação, nunca concluir silenciosamente. F2 inicial: erro estruturado +
  `nextActions` é mais seguro que reuso heurístico — não prometer idempotência completa.
- **Política efetiva de privacidade única**: resolver flag/config/env uma vez, propagar a
  política efetiva ao preflight, store e relatório; recusar inconsistência sem ampliar
  permissões implicitamente.
- `nextActions` distingue autorização: automática / após correção / requer autorização.
  `REVIEW_REFERENCE` **nunca** autoriza `reference adopt`.
- `--help` e `--help --json` em **todos** os comandos; schemas/defaults gerados do mesmo
  registro (fonte única = schemas).
- Idempotência: invocação repetida não cria sessão nova nem gasta tentativa silenciosamente.

## 4. Velocidade — medir primeiro, depois eliminar trabalho

1. **Instrumentar fases**: preflight, hashing, checks, builds, boot/browser, reset, captura,
   comparação, persistência. Frio/quente, p50/p95. (Sem medição, qualquer corte é chute.)
2. **Cache de source preparado**: chave = arquivos relevantes + lockfile + comandos +
   fixtures/reset + bindings + política + versão harness/browser + ambiente declarado.
   Reutiliza traces/snapshots/build somente com identidade válida.
3. **Não cachear o desconhecido**: backend real, serviço externo ou dependência não
   identificável → recaptura ou limitação explícita. TTL não prova igualdade de ambiente.
4. **Feedback focalizado**: modo diagnóstico por cenário, com cobertura parcial declarada —
   nunca conclusão final. Budget segue contabilizado.
5. **Target sempre verificado completo e atual**. Cache de target exige identidade exata.
6. **Paralelismo limitado**: builds/checks independentes + cenários com estado isolado.
   Contexto Playwright isolado não basta se reset altera banco compartilhado.
7. **Cortar o caminho principal**: adapters lint/TS/a11y, descoberta Angular, codemods e
   Docker não carregam na inicialização do verificador.

**Kill switch do legado (DECISÃO DO DONO, 2026-10-03 — escopo TOTAL):** ao fechar o gate
estável, remove-se numa tacada só: **os 26 comandos legados, incluindo o perfil restricted
inteiro (brief/apply-patch/contract tools — aposentado junto)**; os testes do lote
"superfície legada"; `docs/COPILOT-MIGRATION.md` (superado pelo OPERATOR.md); e a
papeleria restante. A v2 (`init/doctor/prepare/verify/status/reference`) vira a única
superfície. Consequências: AGENTS.md §1–8 (protocolo restricted) precisa de rework — o
protocolo de briefs se aplica a um modo que deixa de existir; `apply-patch`, `brief`,
`run`, `transform` e os contract tools saem do código e dos testes. Gate da remoção: gate
estável verde + invariantes (lote a) vivos nos donos v2. Antes disso o legado continua
funcionando — ele é a rede de retardo da migração, não um produto paralelo.

**Ordem de alavancas (corrigida após revisão de rumo 2026-10-03):**
1. **Medição fina primeiro**: separar launch/contexto/navegação/steps/close — o span `boot`
   atual mede a **captura inteira** (não só o launch), portanto os 54–67% não são ganho
   recuperável por pooling. Medir também um ciclo CLI+sessão real (o bench atual chama o
   engine direto) e ≥1 cenário representativo antes de estimar ganhos.
2. **Reuso do processo Browser dentro da operação** (BrowserContext novo por captura; nunca
   reutilizar contexto/page — cookies, mocks e estado contaminam). Sem daemon
   cross-invocation inicialmente.
3. **Cache de build imutável** (sem cache de checks/testes junto). Identidade obrigatória:
   bytes de inputs transitivos + lockfile **e instalação efetiva** + argv/cwd/env efetivos +
   runtime/toolchain + plataforma (separada por OS) + versão do protocolo de cache + hash
   dos outputs verificado ao consumir. Entrada oculta/rede não fixada ⇒ não cacheável;
   publicação atômica; cache corrompido ⇒ miss, nunca sucesso; checks required continuam
   rodando. **Chave de cache de build ≠ chave de cache de evidência** (esta inclui ainda
   política, cenários, fixtures/reset, bindings, versão runner/browser).
4. **Cache de observações source** só depois de contrato próprio de validade (falso-PASS é o
   risco nº 1; TTL não prova igualdade de ambiente).
5. **Paralelismo por último**, condicionado a isolamento de reset/backend.

Maior risco: cache com chave incompleta (→ falso PASS). Não começar por grafo incremental
sofisticado. Ganho medido em ambiente controlado (p95), nunca comparando com runs sob carga.

## 5. Windows — eliminar pressupostos POSIX

- Camada de plataforma única: paths, permissões, processos, locks, persistência. Domínio
  usa IDs/paths relativos canônicos; a fronteira converte paths nativos.
- Hashes dos **bytes reais**; nunca normalizar CRLF em silêncio. Diagnosticar mudança de bytes.
- Execução por `argv`/`cwd`, sem strings de shell embutidas; resolução de executáveis e
  wrappers Windows testada (Job Objects para cleanup de árvore de processos, com testes de
  cancelamento/crash).
- Store com ACLs NTFS verificadas. Honestidade: ACL do mesmo usuário **não** isola a IA —
  ameaça same-user exige broker/conta separada; dizer isso claramente.
- CI obrigatória: Windows nativo + Linux + macOS, cobrindo espaços, Unicode, paths longos,
  CRLF, timeout, arquivos bloqueados. Garantia indisponível → recusa clara, não skip invisível.
- WSL é fallback suportado, não solução disfarçada.

## 6. Documentação para IA

| Ação | Documento |
|---|---|
| **Novo** | `docs/OPERATOR.md` (2–4 páginas): instalar → doctor → prepare → editar → verify → reparar/parar. Exemplos copiáveis (bash + PowerShell). |
| **Novo** | Referência **gerada**: comandos, config (`MigrationConfig`), resultados, catálogo de códigos. Exemplos validados em CI. |
| **Novo** | Troubleshooting por sintoma/código, incluindo permissões, browser, locks, recuperação de interrupção, CRLF. |
| **Reescrever curto** | `AGENTS.md`: limites de confiança + fluxo + links. Tirar RFC+PLAN da leitura obrigatória (−68 KB). |
| **Arquivar** | `VALIDATION.md`, `AUDIT-*`, `REVIEWS`, `PUBLICATION`, `CINEMA-EVIDENCE`, `MCP-COPILOT-EVIDENCE` → `docs/archive/` datado. `COMPETITIVE`/`research`/`PLAN-PHP-JAVA` → `docs/research/`. |
| **Resolver** | **Fechado (2026-10-04):** `llm-wiki/` removido por decisão do dono (era teste de outro projeto). |
| **Atualizar** | `README.md` (start-here = 3 links), `OS-PORTABILITY.md` (separar estado atual × histórico), `STATUS.md`/`ARCHITECTURE.md` (corrigir "proposed", Cinema, comando inexistente). |

## 7. Consolidação de pacotes (fase final)

De 15 para 3–5 unidades: `core` (schemas, tipos inferidos, paths, normalização),
`engine` (referência, sessão, captura, verificação), `cli` (envelope, comandos, compat),
`adapters` (opcionais: quality-gates, codemods, static-analyzer), `mcp-server` (fino,
consumindo a política compartilhada de IO). Regras: schema = fonte única de verdade;
nenhum re-export decorativo; barrel sem adaptadores pesados.

## 8. Sequência de execução

| Fase | Conteúdo | Saída verificável |
|---|---|---|
| **F0 — Medir & caracterizar** | Instrumentação de fases; testes de caracterização do fluxo atual (PASS/FAIL/INCONCLUSIVE/privacidade); métricas-base | Benchmark reproduzível + suíte de caracterização verde |
| **F1 — Clareza imediata** | Corrigir contradições de docs; `--help` nos 26 comandos; catálogo `código → causa → ação`; erros parametrizados (fim de `INVALID_MIGRATION_INPUT_OR_OUTPUT` genérico); OPERATOR.md | Um agente novo completa um fluxo lendo ≤ 40 KB |
| **F2 — CLI v2 sobre o motor atual** | 6 comandos + envelope JSON + `nextActions` + idempotência; restricted em `migrate-compat`; IO público unificado CLI/MCP | Paridade de decisão com o fluxo atual em teste de caracterização |
| **F3 — Velocidade** | Cache de source com testes de invalidação; paralelismo limitado; cortes do caminho principal | p50 de `verify` medido antes/depois; zero falso-PASS nos testes de invalidação |
| **F4 — Consolidação** | Pacotes 3–5; tipos inferidos; remoção de código morto; CI Windows nativo obrigatório | Build único; CI 3-OS verde; LOC/superfície pública medidos |

Cada fase termina com o motor antigo ainda utilizável; nada é removido antes do substituto
demonstrar paridade.

### 8.0 Política de validação por camadas (custo de ciclo)

A suíte completa (~13 min: 361 main + 32 browser) roda **uma única vez por integração de
fase**, pelo orquestrador. Durante o trabalho das lanes:
- **Camada 1 (feedback rápido):** testes do escopo tocado + `tests/characterization-*.test.mjs`
  (rede de paridade, ~2 min) quando a mudança tocar semântica de decisão/exit code.
- **Camada 2 (gate de integração):** build + suíte main + suíte browser + `check:docs`,
  uma vez, em máquina sem execução paralela de testes (portas fixas de `api-first-*`
  colidem sob paralelismo).
- Bench (`scripts/bench-verify.mjs`) só quando a mudança afetar performance; `--runs 3`
  apenas para medição de aceite, 1 run para sanidade.

## 11. Estratégia de testes (decisão 2026-10-03, revisão de arquitetura)

**Fatos:** 361 testes / ~570 s seriais (`--test-concurrency=1`); duplicação de cobertura
(exit codes 4×, refusals 2×, decisões de sessão 3×, privacidade 4×); portas fixas de
`api-first-*` (8310/8353) travam concorrência e já causaram colisão entre lanes.

**Camadas (por recurso, não por diretório):**
- **L1 — dev loop, <60 s:** sem browser, sem builds de app, sem prepare/verify completo.
  Schemas, comparação pura, tabela de combinações/exit mapping, normalização, screening.
- **L2 — integração:** CLI/processo/FS real sem cadeia browser: envelope, paths/permissões,
  locks, journal, budgets, interrupção, idempotência, build/serve, API. Integração negativa
  e corrupção são centrais aqui.
- **L3 — browser/gate:** prepare→session→verify ponta a ponta, estabilidade de source,
  regressões intencionais, privacidade, bindings/reset, cancelamento.
- **Gate = L1+L2+L3** na mesma revisão construída.

**Dono único por comportamento:** um arquivo detém a matriz exaustiva de um contrato; os
demais níveis testam conexão com casos discriminantes. Revisão pergunta: "qual bug novo
este teste captura que o dono atual não captura?" Expansão de matriz acontece no nível mais
barato que observa o contrato. Nunca criar segunda implementação do oráculo em helpers.

**Caracterização — DECISÃO DO DONO (2026-10-03): o legado morre na saída da v2.** A suíte
se divide em dois lotes: (a) **invariantes** — decisões de sessão, exit codes, refusals,
privacidade, perfis: a v2 herda o mesmo engine e essa semântica é contrato dela; migram
para L1/L2 como testes normais e sobrevivem ao kill switch; (b) **superfície legada** —
flags/comandos/help dos 26 comandos antigos: mortos junto com o legado. A auditoria de
sobreposição classifica cada teste em um dos lotes; deduplicação assume o mundo sem legado.

**Paralelismo em 2 etapas:** (1) classificar arquivos em `parallel-safe` × `exclusive`
(motivo explícito por exclusão); rodar isolados com `--test-concurrency=2`, exclusivos em
serial; build único antes dos testes; limite global por host. (2) Liberar exclusivos por
evidência: portas `listen(0)`, cleanup em `finally`, sem dependência de ordem, workspace/
chaves/estado isolados. Validar em 3–5 execuções completas. Cuidado: `build-workspace.mjs`
fecha listeners antes do servidor real usar as portas — reduz corrida, não elimina.

**Não fazer:** pular regressões intencionais / evidência ausente / scope / privacidade /
budgets; reduzir `sourceRuns` nos testes de estabilidade; compartilhar BrowserContext ou
backend mutável; retries como critério de verde; skip de flaky; gate só de changed-files;
dedup por assert textual; aumentar todos os timeouts.

**Sinais de alarme:** falha só em paralelo → isolar o grupo, não a suíte; retries
necessários → bloquear promoção da config; p95 piora ou processos vivos → reduzir
concorrência; mutação conhecida deixa de ser detectada → restaurar cobertura antes de
aceitar economia; L1 >60 s → revisar casos caros; CLI real deixa de ser exercitada em
recusas/inconclusivos → restabelecer canônicos.

**Plano (1–3 dias):** dia 1 = L1 explícita + tempos por arquivo + concorrência 2 nos
isolados; dia 2 = portas dinâmicas + cleanup; dia 3 = comparar serial×paralelo e ajustar
os maiores desperdícios confirmados pela auditoria de sobreposição. **Alvo:** L1 <60 s,
principal ~6–7 min com concorrência 2. Deduplicação de cobertura vem depois dos ganhos de
agendamento e é orientada pela auditoria (não os bloqueia).

### 11.1 Dados medidos e execução concreta (auditoria 2026-10-03)

**Medição real** (63 arq/353 testes main = 603,6 s + 11 arq browser = 139,5 s → gate 743 s
serial). Concentração: **16 arquivos ≥10 s = 85% do tempo**; 31 arquivos leves = 17,2 s.
`api-first-acceptance` = **156 s (26%)**; `assistant-loop` 74 s; `v2-commands` 44 s;
characterization = 114,5 s (19%). Custo real de fixture não é `buildWorkspace` (FS puro,
<5 s total) e sim `prepareMigration`/`verifyMigration` completos (2–4 s cada, lançam
chromium) repetidos dentro do corpo de `test()` — a suíte inteira **não tem hooks before/**
**beforeEach** (42 chamadas de fixture por teste).

**Execução concreta:**
1. **L1 = ~50 s**: 31 arquivos leves (17,2 s) + leak-screening + v2-privacy +
   migration-operations (subset sem chromium) + build-servers ≈ 50 s. Sem chromium, sem
   prepare completo.
2. **Concorrência 2** só onde há trava: `api-first-*` é o único com porta fixa (8310/8353);
   o resto já usa `listen(0)`. Com a trava liberada: main ~600 → **~330–370 s**; com
   `api-first-*` movido para L3/exclusivos: **~250 s**.
3. **Dedup por dono único** (por fixture idêntica + matriz idêntica, nunca por texto de
   assert): fundir ~14 testes redundantes da caracterização nos donos canônicos
   (−60 a −80 s), mantendo os asserts-contrato que só ela pinava: matriz **decision×exit**,
   **atomicidade de lote** + `stdout=="REFUSED"`, exit 3 de `migration-session-status`,
   restricted via `--preparation`, privacidade degradada e2e. `cliRun` copiada em 6 arquivos
   e `journal()`/`preparationFor` duplicados viram helpers compartilhados.
4. **Classificação para o kill switch** (donos canônicos decidem sobrevivência):
   *invariantes* = matriz decision×exit, refusals, privacidade, budgets, escopo — migram
   para L1/L2; *superfície legada* = help/flags dos 26 comandos antigos e fluxos
   exclusivamente legados — morrem com o legado.
5. **Riscos da fusão**: characterization roda chromium **sem t.skip** (quebra em host sem
   browser — corrigir ao mover para L3); a fusão deve preservar exit==3 exato, atomicidade
   e decision×exit (são contrato, não redundância).

### 11.2 Aceitação com agente novo (2026-10-03) — pendências de clareza

Experimento: agente operador com acesso APENAS a AGENTS.md + OPERATOR.md operou o ciclo
completo numa cópia de `examples/validation-first` (31 invocações, ~40 s de CLI). Veredito:
**ciclo completável**; contrato do envelope 100% literal (exit codes, combinações,
`nextActions`, autorização, orçamento, privacidade). Pendências (motivo da lane de
polimento):

| # | Classe | Pendência |
|---|---|---|
| A1 | BLOQUEOU | `examples/validation-first/migration.json` sem `profile: "standard"`; `doctor` PASSa sem apontar; guia não diz onde entra o campo |
| A2 | confundiu | Sem caminho para resolver `missingDecisions` pós-`init` (doctor reporta ambiente, não decisões) |
| A3 | confundiu | `action` recomenda `check-projects --preflight-only` sem as flags required (`--artifact-root`, `--out`) |
| A4 | confundiu | `prepare` re-executado devolve `SESSION_ALREADY_EXISTS` (fora da doc §6) em vez de `ARTIFACT_NOT_FRESH`+`replayOf`; precedência de recusas não documentada |
| A5 | confundiu | Orçamento (attemptsRemaining/remainingMs) não derivável do guia; `reference` consome tempo ativo sem attempt |
| A6 | confundiu | Semântica de `COMPLETE` para o operador não definida; `reference` invalida relatório sem explicação |
| A7 | atrasou | Sem caminho documentado para diagnosticar FAIL: `evidencePaths` relativos sem base; comparações sem expected/actual |
| A8 | menor | §4 sugere `--json` universal; compat não aceita (escopar aos 6 comandos v2) |
| A9 | menor | `sessionId` presente em recusa de sessão inexistente; recusa `STOP_LIMIT` com `diagnostics: []` |

**Polimento (2026-10-03) — TODAS as 9 pendências corrigidas:** A1 `profile: standard` no
exemplo + finding em `doctor`; A2/A5/A6/A8 no OPERATOR.md (First run, tabela
missingDecisions, orçamento, `COMPLETE`); A3 actions literalmente executáveis (preferindo
v2) + `refusalPrecedence` publicado; A4 replay (`ARTIFACT_NOT_FRESH`+`replayOf`) separado
de conflito (`SESSION_ALREADY_EXISTS`); A7 `expected`/`actual` sanitizados em
`comparisons/*.json` + relatório (escopo estendido a core/engine, aprovado); A9 sem
`sessionId` fantasma, todo exit 3 com diagnóstico do catálogo (+3 códigos). Correção pós-
lane: célula de orçamento de `reference` alinhada ao engine (não cobra `usedMs`).
Observação aberta menor: `prepare` INCONCLUSIVE sai com `diagnostics: []` (report carrega
os diagnósticos) — mesmo padrão do A9, fora do contrato pedido; candidato ao polimento
seguinte.

### 11.3 Flakiness L3 — causa-raiz (oracle, 2026-10-03)

4 execuções de L3, 3 sintomas: `migration-verify` (determinístico, **corrigido** — config
do exemplo ganhou `profile` e o teste exercitava restricted; fixture derivada sem profile),
`websocket.test.mjs:36` (1×), `acceptance negative: …no progress` (1×). Isolados verdes.

**A — WebSocket causality:** o recorder (`temporal-recorder.ts`) associa cada frame ao
**último `recordUserInteraction` processado** — ordem de chegada, não timestamp; o runner
registra a interação **antes** do click/auto-wait, e o fixture envia `hello` em `onopen`
sem sincronizar com o início do step ⇒ frame pré-interação pode receber o pai da interação.
*Flakiness = pré-condição não estabelecida pelo teste* (fix: sincronizar handshake antes de
liberar o step, preservando todos os asserts). *Limitação de produto* a registrar:
`causedByEventIds` é associação por proximidade de processamento, não causalidade provada
(RFC §8–9 limita causalidade a dependências declaradas). **DECISÃO DO DONO (2026-10-03):
manter a associação documentada** — sem mudança de schema; o teste determinístico fixa o
comportamento (entrega atrasada + frame autônomo) e a limitação fica registrada aqui e no
próprio teste. Separar associação temporal × causalidade demonstrável fica como evolução
futura se o contrato de evidência passar a exigir aresta comprovada.

**B — STOP_NO_PROGRESS:** causa aberta (a saída do run 4 não foi capturada). Fatos: budget
do teste é 600 s (não apertado); precedência `SESSION_TIME_LIMIT`→`STOP_LIMIT` é correta
(RFC §12) e **não se muda para satisfazer teste**. Suspeitos: (1) janela assíncrona do
cenário `guard` (fetch → `Saved` sem completion signal ⇒ fingerprints divergem ⇒ a falha
deixa de ser "idêntica"); (2) A7 copiou `expected/actual` para diagnostics e o fingerprint
de sessão digere o diagnostic inteiro ⇒ enriquecimento de apresentação pode alterar "mesma
falha" (normalizar só campos não-semânticos no digest, se provado). Bifurcação por evidência:
`REPAIR_IMPLEMENTATION` com fingerprints distintos → comparar diagnostics; variação só de
apresentação → normalizar fingerprint (produto); variação do checkpoint `guard` → marcador
neutro de execução terminada nos dois lados (teste), preservando `NO_REQUEST` e defeitos
plantados.

**Política de gate:** estrito; verde após retry não é execução válida. Quarentena em
`exclusive` só para os arquivos afetados, com motivo e critério de retorno — nunca como
resolução técnica. Validação dos fixes em máquina sem lanes concorrentes; mudanças
comparadas isoladamente antes de acusar regressão F3a/F3b/A7.

**Fixes (fix-12, 2026-10-03) — ambos fechados com evidência:**
- **A:** gate físico de handshake no fixture (`/ws-hold` parser-blocking; página só libera
  após o eco observado pelo recorder — desabilitar botão não bastaria, a interação é
  registrada antes do auto-wait). Assert novo de pré-condição; asserts originais byte a
  byte intactos; teste determinístico novo fixa a limitação (entrega atrasada + frame
  autônomo), citando RFC §8-9. **Mutation check:** gate removido → testes falham; gate
  presente + atraso 500 ms → 5/5 verdes. Contrato do campo segue pendência do dono.
- **B:** evidência coletada (10 execuções com espelho): 6/10 divergiam com
  `decision=REPAIR_IMPLEMENTATION` (nunca `SESSION_TIME_LIMIT`; budget/precedência
  corretos e intocados); candidato idêntico; o diff era **um único campo** —
  `expected[0].targetRoles` do warning ARIA do cenário `guard` (enriquecimento de
  apresentação do A7 no digest). Ramo tomado: **normalização do fingerprint no produto**
  (`failureFingerprint()` em `migration-session.ts` digere só campos semânticos;
  `expected`/`actual` excluídos; ordem-insensível) + teste obrigatório de que apresentação
  não muda fingerprint mas falhas distintas continuam distintas. **6/10 → 0/10** (10/10
  `STOP_NO_PROGRESS`). O checkpoint `guard` nunca variou — ramo do marcador neutro não
  acionado.

### 8.1 Progresso (registro de execução)

| Data | Fase | Status | Evidência |
|---|---|---|---|
| 2026-10-03 | F0 instrumentação | **concluída** | `packages/engine/src/timings.ts` + `timings.json` por run + `scripts/bench-verify.mjs` (p50/p95 por fase); suíte 314/314 + browser 32/32 verdes; overhead <2% |
| 2026-10-03 | F1 docs | **concluída** | Contradições corrigidas (standard/Cinema/comandos), 9 arquivos → `docs/archive/`+`docs/research/`, AGENTS.md §1–8 byte-idênticos, corpus ativo −18,4 KB, `check:docs`/`check:portability` verdes |
| 2026-10-03 | F0 caracterização | **concluída** | 6 arquivos `tests/characterization-*.test.mjs`, 30 testes verdes (2 execuções): decisões de sessão, status PASS/FAIL/INCONCLUSIVE, exit codes 0/1/3/4/5, 10 refusal codes, disclosures de privacidade, perfis standard/restricted |
| 2026-10-03 | F1 help + erros | em curso | `packages/cli` + `docs/reference/errors.md` |
| 2026-10-03 | Revisão de rumo (oracle) | **aprovada com correções** | F0/F1 justificam F2; ordem de alavancas F3 corrigida (medição fina → browser process reuse → build cache → evidence cache → paralelismo); envelope exige tabela de combinações válidas; idempotência por chave de requisição; política de privacidade efetiva única |
| 2026-10-03 | F1 help + erros | **concluída** | Registry de 26 comandos com `--help`/`--help --json` (exit 0), catálogo de 114 códigos `{code, category, cause, action, retryable}`, envelope de erro em `--json`, fim do `INVALID_MIGRATION_INPUT_OR_OUTPUT`, `docs/reference/errors.md`; exit codes intactos; 335/335 verdes no gate |
| 2026-10-03 | F3a medição fina + browser reuse | **concluída** | `boot` decomposto (launch/context/navigation/steps/close + preflightBrowser); 1 Browser por operação com BrowserContext novo por captura; **ciclo prepare+verify 2750→1808 ms p50 (−34,3%)**, launches 7→2; 7 testes de segurança novos (contaminação, isolamento, ordem, abort/crash + árvore de processos); 361/361 + 32/32 verdes |
| 2026-10-03 | F2 envelope + 6 comandos | **concluída** | `packages/cli/src/v2/*`: envelope com `COMBINATION_TABLE` (32 trios, exit codes imutáveis), `nextActions` com `requiresApproval` validado em código (REVIEW_REFERENCE nunca autoriza adoção), política de privacidade efetiva única (conflito recusado), `requestKey`/`replayOf` em `ARTIFACT_NOT_FRESH`; 6 comandos (init/doctor/prepare/verify/status/reference) 1:1 sobre o engine; legados intactos; `docs/OPERATOR.md` (AGENTS+OPERATOR = 25,2 KB ≤ 40 KB); 361/361 + check:docs verdes |
| 2026-10-03 | F3b cache de build | **concluída com ressalvas** | `packages/engine/src/build-cache.ts`: identidade de cache declarada (inputs transitivos + lockfile E instalação efetiva + argv/env/toolchain + plataforma + protocolo), restore verificado, publicação atômica, miss forçado em entrada não identificável, flag A/B. **Em contenção:** o cache com identidade incompleta está sendo movido para opt-in por lane paralela — a chave ainda não é prova completa de equivalência de ambiente. Checks required continuam rodando; **checks embutidos no build são recompostos como PASS** a partir do build cacheado (não reexecutados) — qualificação do "nunca cacheados". **`builds` p50 373→29 ms (−92%)**, total −24% (stock) e −31% (com check required); 17 testes novos (invalidação/publicação/required/contrato); limitações declaradas (mutação em pacote instalado, rede não observada) |
| 2026-10-03 | Testes dia 1 (L1 + concorrência) | **concluída** | `tests/test-groups.mjs` (78 arquivos em L1/L2/L3/exclusive, cobertura exata checada) + scripts `test:l1|l2|l3|exclusive|fast|groups`; **L1 = 45 s estável (3×), dev loop 603→45 s**; L2 c=2: 279→158 s (−43%, 3× sem flakiness); guards `t.skip` chromium em 4 arquivos de caracterização (9 skips em host sem browser, 0 fail); api-first-* promovido a exclusive (portas fixas) |
| 2026-10-03 | Gate de integração | **verde** | Todas as camadas: L1 189/189 + subset ops, L2 c=2 132/132, L3 54/54, exclusive 28/28, check:docs 137 links PASS |
| 2026-10-03 | Aceitação (agente novo) | **aprovada com pendências** | Ciclo completo operando só com AGENTS.md+OPERATOR.md (31 invocações; exit codes/combinações/nextActions/autorização/privacidade literais); 40 s de CLI; 1 bloqueio (A1: `profile` ausente no config do example) + 8 atritos de clareza (A2-A9) → lane de polimento; detalhe em §11.2 |
| 2026-10-03 | Flakiness L3 + gate serial | **verde** | Fixes A/B (§11.3) com evidência; gate em máquina quieta: L1 189/189, L2 c=2 142/142, **L3 57/57 em 2 execuções consecutivas**, exclusive 28/28, check:docs 137 PASS — condição do kill switch atendida |
| 2026-10-03 | Classificação p/ kill switch | **pronta** | 82 arquivos de teste classificados: **6 MORRE** (87 KB / 139 s: assistant-loop, characterization-apply-patch-refusals, leak-screening, cli, har-import-boundary, copilot-hook), **16 REWRITE** (167 KB; asserts-contrato mapeados para donos v2), **60 SOBREVIVE**; 13 asserts migram (lista na ordem de serviço abaixo); sem herdeiro e morrem por decisão: matriz §6 do apply-patch, interface restricted `--preparation`, hook de brief, screening de submissão |
| 2026-10-03 | Kill switch docs | **concluído** | AGENTS.md reescrito v2-only (9,3→5,85 KB, trust limits preservados), USAGE.md → índice→OPERATOR (34→4,3 KB), `COPILOT-MIGRATION.md` + 2 agentes restricted deletados, `migracao-padrao` = operador v2, RFC §3 WITHDRAWN + remapeada p/ v2, STATUS/ARCHITECTURE/ASSISTANT-INTEGRATION/README/OPERATOR sem instrução legada (0 refs vigentes); check:docs 145 links verde |
| 2026-10-03 | Examples + templates | **concluído** | 4 READMEs de examples reescritos para o ciclo v2 (doctor→prepare→editar→verify→status/reference), `MIGRATION-SPEC.md` sem ponteiro para COPILOT-MIGRATION; check:docs 151 links verde; `--help` confirma os 6 comandos como superfície total |
| 2026-10-03 | Kill switch código+testes | **concluído** | 1.461 LOC removidos (5 testes MORRE + assistant.ts/migration.ts/project-checks.ts) + `assistant-files.ts` reduzido a IO público; 16 REWRITE fechados; asserts-contrato migrados para donos v2 (`v2-decisions`, `v2-envelope`, `v2-privacy`, `v2-polish-refusals`, `artifact-lifecycle`… — o `har-import` listado aqui como dono morreu junto, `har-import-boundary` estava na lista MORRE); `tests/helpers/session.mjs` (dedup journal); catálogo 117→107 códigos; MCP sem tools brief/apply; L1 170/170 + L2 focado 45/45 + check:docs 151 verde. **Órfãos-candidatos p/ F4** — a premissa "não deletados, `scripts/pilot.mjs` os consome" foi desprovada (o próprio `scripts/pilot.mjs` saiu no F4a2): `packages/codemods`, `packages/contract-synthesizer` e `core/src/brief.ts` removidos no F4a/F4a2; rótulos legados de `engine/timings.ts` → v2 no F4a |
| 2026-10-03 | MCP restricted + lint | **concluído** | `preparationPath` removido (última superfície restricted; recusa `INVALID_INPUT:preparation-path`); MCP = vocabulário v2 puro (`STANDARD_PROFILE_REQUIRED`/`STANDARD_SESSION_REQUIRED`/`SESSION_ALREADY_EXISTS`…); `build-cache.ts` com `coversPosix` (check:portability-lint PASS) |
| 2026-10-03 | **GATE ÚNICO FINAL** | **VERDE** | Build PASS · cobertura exata 76 arquivos · **L1 170/170 · L2 c=2 108/108 · L3 54/54 · exclusive 21/21** · check:docs 151 links · check:portability PASS. Achado do gate: `migration-verify.test.mjs` com vazamento de sessão (t.after limpava só o private root; journal determinístico → 2ª execução recusava `SESSION_ALREADY_EXISTS`) — fixture corrigida (limpeza da sessão inteira) + poluição varrida; idempotência provada em 2 execuções consecutivas |
| 2026-10-03 | F4a limpeza parcial | **concluída** | `core/src/brief.ts` (137 LOC) + smokes/e2e-fixture.mjs deletados (verificação de órfãos obrigatória recusou 3 grupos: os 4 pacotes têm importadores em testes — premissa do relatório anterior estava errada); labels de timings → v2 |
| 2026-10-03 | F4c CI Windows | **concluído** | `ci.yml` = matriz 3-OS nativa (ubuntu/windows/macos, fail-fast:false), todos os layers em cada OS, guarda de skips ciente do SO (Windows isenta só `POSIX`/`win32` documentados; Linux budget 2 intacto — recusa clara > skip invisível), `corepack pnpm` + `shell: bash` globais, CRLF conservador (`core.autocrlf=false`, sem .gitattributes) documentado em comentário. Validado local: YAML parse, `bash -n` nos 14 run blocks, guard simulado em 4 cenários, portability+docs PASS. **Valida-se de verdade no primeiro push** (corepack download, skips reais por OS, tooling mvn/php/java) |
| 2026-10-03 | F4a2 pipeline morto | **concluído** | 4 pacotes do restricted deletados (codemods/contract-synthesizer/static-analyzer/transformation-planner = 1.594 LOC), FSM, scripts pilot/e2e-fixture/e2e_browser, 8 testes, 3 adapters de quality-gates, `examples/e2e-customer-profile`; cirurgia em `security`/`review-regressions`/`browser/recorder` preservando asserts vivos; refs (tsconfig×2, cli deps, script pilot, test-groups, lockfile) atualizadas. Consumidores verificados antes de cada deleção: **2 superfícies mantidas** por consumidor vivo (`evaluateGates` → `tests/websocket.test.mjs:125-128`; `adaptLegacyComparison` → 4 testes) — cirurgia fica para a F4b. L1 154/154 + subset 13/13 + check:docs 151 verde |
| 2026-10-04 | **F4b consolidação de pacotes** | **concluída** | **11 → 4 pacotes por movimentação de código** (sem shims): `core` ← `contract-review` (54 LOC), `llm-worker` (300), `trace-sanitizer` (104); `engine` ← `quality-gates` (553), `equivalence-validator`/`equivalence` (1.360), `scenario-runner` (495), `trace-recorder` (465) — 29 arquivos / 3.331 LOC em submódulos exportados pelos barrels de destino; `cli` e `mcp-server` só com imports/deps atualizados. Reescritos: 16 specifiers `@migration-harness/{7}` em `packages/*.ts` + 5 statements internos do novo `core` para relativos (sem ciclo de barrel) + 67 caminhos `packages/<X>/dist/...` em 37 arquivos de `tests/`/`scripts/` — **0 restantes**; tsconfig 11 → 4 refs; 10 workspace deps removidas / 4 adicionadas; `pnpm-lock.yaml` regenerado. Follow-ups §8.3 fechados: `evaluateGates`/`GateInput`/`GateResult`/`MinimumCoveragePolicy` removidos (cirurgia em `tests/websocket.test.mjs` preservando os asserts de equivalence-validator); `tests/fixtures/{discovery,forms-io}/` e `scripts/validate-e2e.mjs` (órfão) deletados; `@axe-core/playwright`/`eslint`/`@typescript-eslint/parser` fora do lockfile; docs ARCHITECTURE/STATUS/RFC/PLAN corrigidos. **Validação:** build a partir de limpeza total PASS · `test-groups check` 69 arquivos · **L1 154/154** · segurança 6/6, review-regressions 7/7, websocket 7/7, unit-assertions 7/7, persistence-stability 4/4, migration-report 10/10, equivalence-values 7/7, scenario-bindings 4/4, worker-http 1/1, mcp-server 3/3, mcp-boundary 7/7, browser/recorder 3/3, browser/capture-suite 6/6, browser/scenario-checkpoints 1/1 · check:docs 155 PASS · check:portability PASS |
| 2026-10-04 | **GATE FINAL PÓS-F4** | **VERDE** | Build do zero (clean+build, valida o fix do `clean.mjs` p/ tsbuildinfo) · cobertura exata 69 arquivos **(contagem em correção por lane paralela)** · **L1 154/154 · L1-ops 4/6 (2 skips de padrão) · L2 c=2 92/92 · L3 52/52 · exclusive 21/21** · check:docs 155 links · check:portability PASS. Achado do gate: barrel do engine reexportava `scenario-runner`/`trace-recorder` (Playwright no entrypoint — violava §7 "barrel sem adaptadores pesados" e o teste `project-reset`); corrigido removendo as 2 linhas do barrel (todos os consumidores já importam por subcaminho; código interno usa `await import()` de propósito). Resíduos fechados junto: `ReleaseEligibility` órfão removido, `clean.mjs` agora limpa `*.tsbuildinfo`, linhas falsas de PLAN/PLAN-V2 corrigidas |
| 2026-10-04 | Fechamento pós-auditoria (oracle) | **em curso** | Auditoria final reprovou o fechamento (2 bloqueadores + resíduos). **Lane B (gate hole) FECHADA:** complemento de `migration-operations` (linhas 96-133, stale-evidence) executa de fato em L3; `check` prova EXECUÇÃO (72 arquivos / 331 `test()` = união exata, com prova negativa validada); skip allowlist **nomeada** `{file,test,os,reason}` substitui isenção por texto; `scripts/run-tests.mjs` Node portável (sem `$(…)` POSIX); CI valida manifest+allowlist; `tests/INVARIANTS.md` = mapa dos 13 invariantes (comportamento→teste→camada). **Assert perdido do kill switch REENCONTRADO e restaurado:** a fronteira private-root do leitor CLI (`assistant-files.ts`) ficou órfã quando `har-import-boundary` morreu — recriada em `tests/public-io-boundary.test.mjs`. **Lane C (docs/help) FECHADA:** `report.report.*` por comando, `status.decision` histórico, quickstart Windows (flag OU env), help strings v2, alegações qualificadas, init owner×derivável + 2 resíduos fechados pelo orquestrador (errors.md exit 4, nesting em migracao-padrao.agent.md). **Lane A (P0 cache opt-in) em curso** |
| 2026-10-04 | **Fechamento pós-auditoria** | **CONCLUÍDO** | Os 2 bloqueadores da auditoria final fechados: **P0** — cache opt-in (`MIGRATION_HARNESS_BUILD_CACHE=1`, default OFF, escrita recusada sem opt-in, protocolo `/2`), gaps de identidade: (a) roots declarados irmãos hasheados, (b) conteúdo de instalação hasheado, (c) rede via script → `NETWORK_REFERENCE`/não-cacheável (fail-closed) + limites documentados (irmão não declarado e rede não observável seguem fora — contenção é o opt-in); `DockerSandbox` removido; core barrel sem `typescript` no load. **P1** — complemento de `migration-operations` executa em L3; manifest prova EXECUÇÃO (333 `test()`); allowlist de skips nomeada; runner Node portável; 13 invariantes mapeados em `tests/INVARIANTS.md`; assert perdido restaurado (`tests/public-io-boundary.test.mjs`); docs/help corrigidos. **GATE FINAL CORRIGIDO: VERDE** — build · manifest (73 arquivos / 333 testes, união exata) · L1 156/156+ops · L2 92/92 · L3 52/52+ops · exclusive 29/29 · check:docs 155 · check:portability PASS. Staging revisado: 6 dirs locais (`.agents/.claude/.codegraph/.mimocode/llm-wiki/piloto`) NÃO entram no commit; o resto é produto |
| 2026-10-04 | IO público unificado + gate final | **CONCLUÍDO** | Fronteira CLI↔MCP unificada em `core/public-surface` (política comum parametrizada): união das garantias aplicada aos dois canais — CLI ganhou normalização de separadores, vocabulário completo de marcadores e reconferência de domínio público no `open`; diferenças legítimas (raízes configuráveis do store, vocabulário de recusa) preservadas como parâmetros; matriz de conformidade única contra os dois adapters (`tests/public-io-conformance.test.mjs`); nenhum assert de fronteira perdido (`public-io-boundary`/`mcp-boundary` 9/9). **GATE FINAL: VERDE** — build · manifest (74 arquivos / 336 `test()`, união exata com prova de execução) · L1 159/159+ops · L2 92/92 · L3 52/52+ops · exclusive 29/29 · check:docs 155 · check:portability PASS. Pendentes do dono: pós-push (matriz CI 3-OS valida de fato no GitHub); `llm-wiki` decidido e **removido** (2026-10-04) |

**PLANO v2 ENTREGUE NO NÚCLEO — não executado por inteiro.** Entregas finais: CLI de 6 comandos + envelope JSON (os 26 legados e o perfil restricted, incluindo MCP e demos, removidos — ~4,2k LOC de superfície morta); performance (ciclo −34%, `builds` −92%, dev loop de testes 603→45 s); documentação AGENTS+OPERATOR ≈ 25 KB de leitura para operar (era ~175 KB); CI 3-OS nativo; 4 pacotes; suíte em camadas (L1 45 s). **Itens abertos** (§8.3): tipos inferidos dos schemas; exports de suporte de teste (`adaptLegacyComparison`/`measureCoverage`); cache de build com identidade incompleta em contenção para opt-in. A contagem de cobertura do gate estava recebendo correção por lane paralela.

### 8.3 Decisões adiadas e follow-ups registrados

- **Adiado consciente:** tipos inferidos dos schemas (615 LOC de shadow types em `core/`) —
  o ganho é eliminar drift, mas defaults/input-output do zod têm semântica sutil; fazer
  quando o schema estiver estável. Decisão registrada para não entrar numa reescrita às
  cegas.
- **Follow-ups fechados na F4b (2026-10-04):** deps mortas em `quality-gates/package.json`
  (`@axe-core/playwright`, `eslint`, `@typescript-eslint/parser` saíram do lockfile junto
  com o pacote; `typescript` permanece — devDependency raiz e dependência de `core` para a
  tela de patches de `bounded-worker.ts`); fixtures órfãs
  `tests/fixtures/{discovery,forms-io}/` deletadas; `scripts/validate-e2e.mjs` deletado
  (órfão: nenhum importador além de si mesmo); texto em ARCHITECTURE/STATUS/RFC
  descrevendo discovery/codemods/importers como "adapters opcionais" corrigido.
- **Superfície de gate removida na F4b:** `evaluateGates`/`GateInput`/`GateResult`/
  `MinimumCoveragePolicy` tinham zero consumidores de produção e saíram, com cirurgia em
  `tests/websocket.test.mjs` que preserva os asserts de equivalence-validator.
- **Decisão registrada (suporte de teste):** `adaptLegacyComparison` (4 testes) e
  `measureCoverage` (`tests/security.test.mjs`) não têm consumidor de produção, mas são
  suporte de teste — mantidos exportados no novo lar
  (`packages/engine/src/quality-gates/{migration-report,coverage}.ts`) em vez de migrados
  para `tests/helpers.mjs`, que reescreveria TS em JS sem ganho.
- **Follow-ups que continuam abertos:** tipos
  inferidos dos schemas (adiado acima);
  `adaptLegacyComparison`/`measureCoverage` seguem exportados apenas como suporte de teste;
  cache de build com identidade incompleta em contenção para opt-in por lane paralela.

### 8.2 Ordem de serviço do kill switch (escopo TOTAL, decisão do dono 2026-10-03)

1. **Código:** remover os 26 comandos legados de `packages/cli` + o perfil restricted inteiro
   (brief/apply-patch/contract tools, `assistant.ts`/`assistant-files.ts`, repair-loop de
   brief). Engine (prepareMigration/verifyMigration/…) **fica** — a v2 o chama.
2. **Testes:** deletar os 6 MORRE; reescrever os 16 REWRITE ligando-se à v2; **migrar os
   13 asserts-contrato** (decision×exit → `tests/v2-decisions.test.mjs` novo; os demais
   conforme o mapa da classificação: `v2-envelope`, `v2-commands`, `v2-privacy`,
   `v2-polish-refusals`, `artifact-lifecycle`, `migration-operations`);
   dedup do dia 3 junto (apagar duplicatas já herdadas — ex.: budgets em
   `migration-session:84-97` ≡ `v2-polish-refusals:263`).
3. **Docs:** AGENTS.md §1–8 rework (protocolo de briefs morre com o modo; vira protocolo
   curto v2-only); deletar `docs/COPILOT-MIGRATION.md`; atualizar `test-groups.mjs`.
4. **Gate único no fim** (uma execução completa), não por etapa.

**Addendum de medição (F3a):** a decomposição mostrou que só `launch` (~52 ms/operação) e
parte de `close` eram pooling-recuperáveis — `context` é intrínseco por captura (mas caiu
com browser morno), `navigation`/`steps` não otimizáveis no harness. **`builds` (~380 ms,
40–45% do total) é agora a maior fase individual** → F3b (cache de build, §4 ordem item 3)
é a próxima alavanca. Bench ainda mede o engine direto; ciclo CLI+sessão real fica para a
validação pós-F2.

**Baseline de performance medido (F0, fixture barato, p50):** prepare 2,5 s / verify 3,4 s.
Domina: `boot` (lançamento de Chromium, ~700–830 ms por captura — 7 launches por ciclo
prepare+verify), `preflight` (17–26%, inclui `chromium.launch()` extra), `builds` (11–15%,
roda nos dois ciclos sem cache). `comparison` ≤0,3% — não otimizar. Alavancas da F3
confirmadas por medição: reuso de browser/contexto com isolamento por captura e cache de
build por identidade. Nota: o 1º run sob carga mediu 46,9 s (boot volátil) — F3 deve medir
em ambiente controlado e reportar p95.

**Insumos de comportamento (F0 caracterização) → decisões da F2:**
1. Exit code segue *outcome*, não *decisão* (REPAIR_IMPLEMENTATION + INCONCLUSIVE sai 5, não 4).
   → O envelope **precisa** separar `operationStatus`/`decision`/`outcome`; exit code é só
   sinopse.
2. Classificação de falha depende do estágio do runner (completion no cenário → FIX_ENVIRONMENT;
   no step → REPAIR_IMPLEMENTATION), não da causa. → F2 documenta essa semântica no catálogo e
   reflete o estágio em `diagnostics`, não regrava a lógica (rede de paridade).
3. `ARTIFACT_NOT_FRESH` em reexecução: não há idempotência hoje. → Item de design da F2
   ("invocação repetida não gasta tentativa") deve resolver: reuso do artefato ou erro
   estruturado com `nextActions` explícito.
4. Privacidade usa dois canais (preflight guiado por env; relatório, pela flag do store). →
   Documentar em OS-PORTABILITY; unificar guia na F2.
5. `FIX_ENVIRONMENT` é quase inalcançável via OPERATION_FAILED (desvia para REVIEW_REFERENCE).
   → Catálogo de códigos deve refletir o que é realmente alcançável.

## 9. Riscos e salvaguardas

| Risco | Salvaguarda |
|---|---|
| Regressão semântica silenciosa | Testes de caracterização + mutações intencionais; testes antigos são evidência, não especificação infalível |
| Falso PASS por cache | Testes de invalidação (source, fixture, política, ambiente, browser, backend, candidato); entrada não rastreável desabilita reuse |
| Privacidade perdida ao "melhorar erros" | Catálogo de códigos com projeções seguras; testes de vazamento nos canais CLI e MCP |
| Compatibilidade enganosa | Formatos versionados; adapters explícitos; nunca reinterpretar resultado restricted como aprovação standard |
| Crash/concorrência | Testes de interrupção entre reserva/execução/persistência; 2 verificações simultâneas; recuperação sem reset de orçamento |
| Recriar burocracia | Nada de framework de plugins, event sourcing ou novo motor de estados abstrato. Abstrair só fronteiras já comprovadas |

### 9.1 Sinais de alarme — parar e reavaliar

| Sinal | Resposta |
|---|---|
| Mutação required deixa de ser detectada, ou evidência ausente passa | Parar rollout da otimização; reproduzir com cache/pooling desligado |
| Replay consome outra tentativa, inicia outra sessão ou devolve PASS antigo como atual | Bloquear F2: contrato de idempotência incorreto |
| Mesmos inputs aparentes produzem outputs diferentes sem explicação | Desabilitar cache do produtor até identificar entrada oculta/não-determinismo |
| Testes passam isolados e falham conforme ordem/pooling | Bloquear reuso/paralelismo: estado compartilhado |
| Política de privacidade difere entre preflight e execução, ou erro expõe dados | Bloquear entrega, qualquer que seja o ganho de performance |
| Agente interpreta timeout como autorização para alterar referência | Rever `decision`/`nextActions`; documentação sozinha não resolve |
| Otimização "ganha" executando menos checks/cenários required | Rejeitar benchmark e mudança: não é aceleração equivalente |
| Ganho dentro da variação, p95 piora, ou processos/memória acumulam | Não adicionar camadas de cache; revisar medição e lifecycle |
| Windows essencial fica skipped ou só testado na consolidação | Antecipar gate multi-OS — o risco já está sendo introduzido em F2/F3 |
| Agente novo ainda precisa de instruções privadas ou leitura além do guia | F1/F2 não atingiram o objetivo, mesmo com menos KB e 6 comandos |

## 10. Métricas de sucesso

- Tempo até a primeira verificação (agente novo → primeiro `verify`).
- Taxa de erro de invocação por agente (flags/inputs rejeitados).
- Tempo de ciclo prepare→verify→reparo (p50/p95 por fase instrumentada).
- Volume de contexto necessário para operar (KB lidos antes da 1ª edição: hoje ~132–175 → alvo ≤ 40).
- Paridade Windows (mesma taxa de pass em CI 3-OS).
- Não usar como métrica: LOC/pacotes removidos sozinhos.
