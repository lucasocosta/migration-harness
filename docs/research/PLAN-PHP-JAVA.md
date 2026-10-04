# P7 — Plano de habilitacao PHP → Java

Status: planejado (2026-09-28). Nenhuma implementacao iniciada; este documento e o
contrato de escopo do primeiro ciclo. Progresso e marcado em [PLAN](../PLAN.md)
secao P7; evidencias futuras em [VALIDATION](../archive/VALIDATION.md) e
[MCP-COPILOT-EVIDENCE](../archive/MCP-COPILOT-EVIDENCE.md).

## Objetivo e tese

Habilitar o perfil `standard` para um par PHP (fonte) → Java (alvo). O motor de
garantia e agnostico de linguagem: ele congela uma referencia, captura os dois
lados ao vivo e compara comportamento observavel com fail-closed. O trabalho real
esta em tres lacunas: modo servidor gerenciado (apps donos da propria porta),
vocabulario de observacao sem browser (se a superficie for API pura) e um gate
de aceitacao proprio, no padrao P4/P5/P6.

## Decisoes: (1) e (2) resolvidas em 2026-09-28; (3) e (4) em aberto

1. RESOLVIDA — Superficie de observacao: **API pura**. Consequencia: P7.3
   (vocabulario HTTP de cenarios) torna-se obrigatorio no primeiro ciclo e deixa
   de ser condicional.
2. RESOLVIDA — Stack alvo: **Spring Boot** (JAR auto-servido).
3. Par de apps piloto: propondo `examples/api-first/` — API PHP (fonte) e API
   Spring Boot (alvo) com os mesmos endpoints (GET /api/profile, PUT
   /api/customer com validacao de e-mail), reaproveitando o formato de regressao
   controlada ja conhecido.
4. Perfil restrito (briefs) para Java: fora do primeiro ciclo (ver Nao-objetivos).
5. RESOLVIDA — Verificacao de banco de dados: **sondas declaradas por lado**
   (design do oraculo, 2026-09-28). Unidade comparada: efeitos em estado logico
   de dominio (projecao JSON canonica emitida por sonda `kind:"probe"`), nunca
   operacoes ou texto de query. Tecnologia-agnostico: SQL, NoSQL ou chave-valor
   por lado, engines diferentes entre fonte e alvo. **Tier 1 e Tier 2 ambos em
   escopo do P7** (decisao do responsavel).

## Fases

### P7.1 Spike do par de apps (M)

- Par PHP→Java minimo com a mesma superficie observavel; `commands` declarados
  (`build`/`serve`/`reset`/`test`), `reset: COMMANDS` para estado.
- Rodar `prepare-migration` e `verify-migration` manualmente e documentar o que
  passa, o que falha e o que e apenas desconforto.
- Aceite: `MIGRATION_PREPARATION: PASS`, fonte `STABLE` em `sourceRuns`, e um
  veredito honesto em pelo menos 1 cenario (PASS/FAIL/INCONCLUSIVE documentado).
- Depende de: decisao de superficie (1). Entrega: relatorio de gaps anexado aqui.

#### Relatorio do spike P7.1 — 2026-09-28 (branch `feat/p7-php-java`)

Ambiente: PHP 8.3.6, OpenJDK 21.0.12.1, Maven 3.8.7. Par `examples/api-first/`
(PHP built-in server :8310 -> Spring Boot 3.3.5 JAR :8353), 3 cenarios
`request`, 5 requisitos `responseClaim`, 4 checks.

- `prepare-migration` -> `MIGRATION_PREPARATION: PASS` (serve gerenciado da
  fonte, capturas HTTP em 2 runs, observacoes `STABLE`).
- `start-migration-session` -> sessao `98efc2e25f1d6927456fea9addc9fd96`
  (`maxAttempts: 4`, `maxActiveMs: 180000`).
- `verify-migration` -> **`COMPLETE`/`PASS`** na tentativa 0: preservacao,
  requisitos e checks nativos PASS; referencia `VERIFIED`; 3/3 cenarios,
  5/5 requisitos, 4/4 checks; `diagnostics: []`.
- Regressao controlada (nucleo do P7.5): `isValidEmail` quebrado no alvo
  (`return true`) -> exit 4 com deteccao em tres camadas — `BEHAVIOR_DIVERGENCE`
  (`NETWORK_STATUS_MISMATCH`, `NETWORK_RESPONSE_SHAPE_MISMATCH`,
  `NETWORK_RESPONSE_FIELD_*`), `REQUIREMENT_VIOLATED (RESPONSE_FIELD_MISSING)` e
  `NATIVE_CHECK_FAILED (target-regression)`; restaurado -> `COMPLETE`/`PASS` na
  tentativa 2 (3/4 tentativas consumidas). Ciclo PASS -> FAIL -> PASS completo.

Gaps e desconfortos encontrados (nenhum bloqueante):

1. Fluxo do perfil standard: `verify-migration --preparation/--artifact-path` e
   recusado com `STANDARD_SESSION_OWNS_REFERENCE_AND_OUTPUT` (correto por
   design — a sessao e dona da referencia/saida). O loop e `prepare-migration`
   -> `start-migration-session` -> `verify-migration` ->
   `migration-session-status`. Melhoria opcional: a recusa poderia sugerir o
   proximo comando.
2. `environment.browser` exige `"chromium"` mesmo em config API-pura (o trace
   ja emite `browser: 'none'`): item de schema futuro permitir `none`.
3. Falha de `responseClaim` produz `REPAIR_IMPLEMENTATION` sem divergencia de
   rede para o loop de reparo mirar (mesmo caso das assertions) — definir
   expectativa de reparo para API pura em P7.5/P7.6.
4. Maven frio e lento (timeout 900s no primeiro `package`; `~/.m2` esquenta);
   `maxActiveMs` conta apenas verificacao, nao build.
5. Banco de dados intencionalmente fora do spike (P7.7/P7.8 em escopo, decisao 5).
6. Assimetria de caminho no CLI (encontrada pela suite de aceitacao P7.5):
   `prepare-migration --artifact-path` resolve contra `--workspace-root`, mas
   `start-migration-session --preparation` resolve contra o CWD do processo —
   mascarado quando `--workspace-root .`. Caminhos absolutos funcionam;
   padronizar a resolucao e melhoria opcional.

Aceite P7.1 batido com folga: `MIGRATION_PREPARATION: PASS`, fonte `STABLE`,
veredito honesto em 3 cenarios (PASS geral + o FAIL da regressao controlada).

### P7.2 Modo servidor gerenciado (L)

- Fechar o item aberto "SSR/custom server" do [STATUS](../STATUS.md): o schema ja
  tem comando `serve`; falta o lado do harness — subir o processo, esperar
  readiness no `baseUrl`, capturar, derrubar a arvore de processos sem residuo.
- Politica de portas: reservadas fora do range efemero do Linux (aprendizado do
  flake 43120) ou o item de backlog "automatic ports".
- Aceite: fonte PHP e alvo Java servidos por processo proprio capturados em 2
  runs com `executionHash` identico (`STABLE`); teardown verificado; testes no
  padrao `tests/browser/`.
- Depende de: P7.1 recomendado; pode iniciar em paralelo com a decisao (1) fechada.

### P7.3 Vocabulario HTTP de cenarios (M, condicional)

- So se a superficie for API pura: steps de request e claims de troca HTTP
  (metodo, status, shape de payload) integrados a politica de comparacao de
  traces — a comparacao de valores de payload ja existe no oraculo.
- Aceite: cenario sem browser capturado e comparado nos dois lados; regressao
  controlada de metodo/payload detectada como `BEHAVIOR_DIVERGENCE`.
- Depende de: P7.2 (servidor gerenciado).

### P7.4 Checks nativos PHP/Java (S)

- `phpunit`/`JUnit` como `checks` via `commands` kind `test`; convencoes de
  assertions para requisitos quando nao ha DOM (claims de teste cobrem a maior
  parte sem vocabulario novo).
- Aceite: check de regressao do lado Java reprova um candidato propositalmente
  quebrado sem tocar no contrato.

### P7.5 Gate de aceitacao P7 (M)

- Regressoes controladas: valor errado, validacao ausente, fluxo errado →
  `FAIL`/`BEHAVIOR_DIVERGENCE` com diagnostico por cenario/requisito.
- Negativas (padrao P4.3): evidencia incompleta nunca vira `COMPLETE`; edicao
  off-scope recusada sem consumir tentativa; budgets persistentes sem reset;
  rebaseline exige decisao do dono; `INCONCLUSIVE` nunca reportado como sucesso.
- Aceite: 5/5 testes de aceitacao registrados em [VALIDATION](../archive/VALIDATION.md).

### P7.6 Piloto assistido e CI (S/M)

- Ciclo completo via Copilot+MCP (uma "Session D" em MCP-COPILOT-EVIDENCE).
- Toolchains PHP + JDK na matriz CI (3 SOes), budget de tempo de build,
  hygiene de portas dos runners.
- Aceite: sessao `COMPLETE`/`PASS` dirigida pelo agente + CI verde.
- Registro (2026-09-29): Session D `COMPLETE`/`PASS` 3/3 · 5/5 · 4/4 obtida; os
  tres primeiros expostos do piloto acharam dois bugs reais de re-prepare
  (crash `EEXIST` na chave de pseudonimizacao; crash `EEXIST` no mkdir de
  diretorio de artefato sujo, agora `ARTIFACT_NOT_FRESH`), corrigidos e cobertos
  por `tests/prepare-retry.test.mjs`. CI verde nos 3 SOes (run 36582270212) apos
  renomear o projeto Java `target/`→`java/` — o gitignore de build outputs
  engolia as fontes no checkout do CI, derrubando setup-java e o prepare.

### P7.7 Banco Tier 1 — cobertura obrigatoria de estado (M)

Todo exemplo com persistencia deve verificar efeitos em estado de dominio
contra persistencia de teste real e controlada. Fonte e alvo podem usar
tecnologias diferentes; o aceite trata estado inicial equivalente, pos-estado
exigido e invariantes — nunca texto de query ou sequencia de operacoes.

- Resets declarados (`reset: COMMANDS`) por lado antes de cada run independente,
  re-semeeiando todos os stores/filas/indices participantes com sentinela de
  estado inicial equivalente; nunca reset entre a mutacao e a leitura.
- Cenarios read-after-write; entrada invalida deixa o estado intacto;
  normalizacao declarada verificada como propriedade de valor; injecao de falha
  em operacoes multi-efeito (rollback sem estado parcial proibido).
- Testes nativos `kind:"test"` com ciclo PROPRIO reset->acao->assercao (checks
  nativos rodam antes da captura da suite e nao inspecionam o pos-estado de
  cenarios posteriores).
- Stores sinteticos reais; mocks nunca contam como evidencia de banco.
- Aceite: mutacao sobrevive a leitura fresca; invalido sem efeito; normalizacao
  conferida; rollback limpo; efeitos de auditoria/cascade/assincronos verificados
  ou nao-aplicabilidade documentada; resets repetiveis (fonte `STABLE`);
  evidencia ausente nunca e COMPLETE; regressoes controladas (persistencia,
  rollback, efeito secundario) detectadas. Divergencia de estado intencional va
  em `acceptedDifferences` com predicados e decisao do dono.
- Registro (2026-09-29): persistencia cross-engine implementada e validada —
  fonte PHP+SQLite (PDO, tabelas relacionais) e alvo Java+H2 (documento JSON),
  escrita atomica cliente+auditoria, injecao de falha declarada (header e campo)
  com rollback completo, `reset: COMMANDS` com baseline sentinela identico,
  probes canonicos byte-identicos entre as engines (incluindo valores exoticos)
  e testes nativos com ciclo proprio (49 checks PHP, 30 Java + 5 guardas de
  escaper). Ciclo completo pelo harness: `COMPLETE`/`PASS` 6/6 cenarios · 14/14
  requisitos · 5/5 checks; regressao controlada (incremento de auditoria
  quebrado) detectada por stateClaim e check nativo. Normalizacao-on-write:
  nao aplicavel (o exemplo ecoa o e-mail sem transformacao); cascade e escrita
  assincrona: nao aplicavel (sem relacoes nem filas) — documentado.

### P7.8 Banco Tier 2 — state capture com sondas declaradas (L)

Arquitetura (decisao 5): cada lado declara um comando `kind:"probe"` (argv
proprio — PHP e Java diferentes) que devolve uma projecao JSON canonica do
estado de dominio; o harness e dono de captura, sanitizacao, comparacao e
avaliacao. O comando retorna observacao, nunca veredito (`equivalent: true` e
proibido); exit 0 = execucao bem-sucedida, nao evidencia completa.

- Config: `stateProjections` (schema de dominio, colecoes `KEYED` por campo
  logico, politica de privacidade com allowlist), `stateCaptures` por cenario
  (projectionId, checkpoint `SCENARIO_END`/`AFTER_RESET`, bindings de comando
  por lado, `settle` com barreira de conclusao), requisitos `stateClaim`
  (`STATE_FIELD` com predicados) analogos a `responseClaim`.
- Evidencia: artefato versionado `STATE_SNAPSHOT` com identidade propria
  (run/cenario/lado/checkpoint, fingerprints de probe/projecao, reset/fixture,
  hash de config/referencia/build), sanitizado; hash e identidade atribuidos
  pelo harness — saida do comando nunca e autoridade.
- Semantica: preservacao (comparacao diferencial) e requisitos avaliados
  separadamente; "igualmente errado nao e sucesso" (dois lados violando o mesmo
  invariante reprova o requisito); alvo pode corrigir defeito da fonte quando o
  requisito o declara (defeito da fonte divulgado); evidencia incompleta,
  ambigua, stale, omitida por privacidade ou nao-resolvida => INCONCLUSIVE.
- Quiescencia: barreira de conclusao declarada e ligada a execucao (token de
  correlacao, watermark de outbox, ack de indice; espera fixa as cegas e
  proibida) — polling do estado esperado tambem e proibido, porque confunde
  "terminou" com "esta certo"; ausencia exigida (ex.: rollback sem escrita)
  requer barreira cobrindo todos os workers ou janela declarada com limitacao
  documentada.
- Privacidade: minimizacao na extracao (so particoes/campos declarados);
  allowlist no harness; stdout bruto privado a execucao (nunca em relatorios,
  CLI, MCP ou contexto do assistente); representacoes de igualdade por HMAC
  type-tagged com chave compartilhada do harness (nunca hash de PII de baixa
  entropia) + tipos estruturais em resumos; chaves/identificadores sinteticos;
  predicado nao-sseguro => NOT_EVALUABLE; telas de leak screening valem para
  definicoes de probe — apos a referencia, probe/projecao sao entradas de
  avaliacao protegidas.
- Estabilidade de fonte: estado entra no `executionHash` e nas comparacoes de
  estabilidade (sem contagens de poll/tempos); evidencia de estado da fonte
  presa a referencia fixa, como os traces.
- Aceite Tier 2 (9 criterios): (1) fixture cross-engine (ex.: SQL -> documento)
  passando com schemas fisicos diferentes; (2) regressoes ocultas detectadas
  (auditoria, normalizacao, orfao, commit parcial, escrita secundaria);
  (3) igualmente-errado reprova requisito independente; (4) snapshots
  incompletos/truncados/ambiguos/stale/omitidos/nao-resolvidos => INCONCLUSIVE;
  (5) barreiras cobrem escritas atrasadas sem polling; (6) estado participa de
  estabilidade, referencia e identidade de run/build/reset; (7) mudancas de
  probe/config nao enfraquecem criterios nem resetam budgets; (8) valores
  brutos, credenciais e pseudonimos nunca chegam a saidas do assistente;
  (9) diferencas semanticas explicitas funcionam; ignores amplos e aceitacao de
  evidencia incompleta sao recusados.
- Registro (2026-09-29): state capture entregue — sondas `kind:"probe"` por lado
  (argv proprio, nunca shell), sanitizacao por allowlist antes da persistencia,
  HMAC keyed type-tagged para `KEYED_EQUALITY` (literais declarados decididos
  dentro de processamento protegido), envelope `STATE_SNAPSHOT` identitario,
  settle `PROBE_BARRIER` por marcador de conclusao declarado, pinning em
  `sourceEvidence[].state` com re-checagem stale no verify, estado no
  executionHash de estabilidade, claims `STATE_FIELD` (EQUALS/ABSENT/KEYED_EQUAL)
  e preservacao diferencial independente com gate de `acceptedDifferences`.
  Criterios: (1) fixture cross-engine SQL relacional -> documento JSON verde;
  (2) regressao oculta detectada (nome persistido sem claim ->
  `BEHAVIOR_DIVERGENCE (STATE_DIVERGENCE)` na preservacao; auditoria e rollback
  pelos claims e testes nativos); (3) igualmente-errado reprova o requisito;
  (4) evidencia ausente/incompleta/stale/unsettled/omitida => INCONCLUSIVE;
  (5) barreiras por marcador declarado, nunca polling do resultado esperado;
  (6) estado participa de estabilidade, referencia e identidade de run/build/
  reset; (7) mudancas de probe/projecao/claims alteram os digests de referencia;
  (8) valores brutos nunca saem do processamento protegido (HMAC + caminhos
  estruturais); (9) diferencas semanticas exigem predicado na fonte + claims
  satisfeitas + decisao do dono, e evidencia incompleta nunca e resolvivel.
  Limites conhecidos: EQUALS sobre `KEYED_EQUALITY` exige a chave protegida
  (sem chave, NOT_EVALUABLE); campos STRUCTURAL nao decidem literais; path de
  claim com curinga e AMBIGUOUS; aplicabilidade por lado (`appliesTo`) e
  refinamento futuro — hoje ambos os lados devem satisfazer.
- Ressalva (revisao do PR #4): as garantias (8) e (9) valem para saida de probe
  declarada e bem-formada; shapes adversariais ou inesperados tem lacunas de
  robustez registradas no backlog do [PLAN](../PLAN.md) (ancestrais e
  chaves-curinga na sanitizacao, falsos passes por evidencia omitida ou
  so-estrutural, binding de evidencia alvo, cardinalidade de
  `acceptedDifferences`, atribuicao de endpoint e teardown de descendentes).

## Nao-objetivos do primeiro ciclo

- Adaptadores de analise estatica (php-parser/JavaParser): inventario manual
  basta; o oraculo nao depende de discovery.
- Briefs do perfil restrito emitindo patches Java (contrato de patch hoje e
  TS/TSX): operar apenas no perfil standard.
- SSR/proxy/HTTPS completos alem do minimo do piloto. Migracao de DADOS de
  producao e transferencia entre engines ficam fora; verificacao de
  COMPORTAMENTO de persistencia esta em escopo (P7.7/P7.8).
- Equivalencia de fonte: semantica PHP→Java (tipagem, includes, exceptions) e
  trabalho do agente; o harness so exige equivalencia observavel.

## Riscos

- Builds Java lentos contra `maxActiveMs` (so tempo de verificacao conta):
  dimensionar `limits` com folga e medir no P7.1.
- Determinismo com estado persistente: resets declarados por comando; se o reset
  for incompleto, a fonte fica `UNSTABLE` e o ciclo trava — correto, mas exige
  fixture disciplinada.
- Portas em CI: fixas devem ficar fora do range efemero (32768-60999 no Linux).
- Shims Windows para `php`/`java` nos runners (aprendizado do `cmd.exe /c`).
- Prazo do piloto assistido depende de o agente Java errar dentro de
  `writePaths` — budgets e escopo ja cobrem isso.
- Sondas enganosas (fixture constante), enumeracao incompleta de estado,
  leituras stale/cached e contaminacao entre runs por workers: mitigadas por
  projecoes declaradas protegidas, barreiras de conclusao e regressoes
  controladas — nao por mais adaptadores de banco.

## Definition of Done (P7)

1. Exemplo PHP→Java versionado e documentado (README no padrao dos exemplos).
2. P7.5 verde com evidencia em VALIDATION.md; negativas comprovadas.
3. P7.6 gravado (Session D) e CI verde na matriz.
4. STATUS.md atualizado: P7 entregue com limites declarados.
5. P7.7 obrigatoria em todo exemplo persistente e P7.8 entregue com os 9
   criterios de aceite, incluindo fixture cross-engine.
6. Decisoes (1)-(5) registradas como resolvidas neste documento.
