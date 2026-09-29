# P7 — Plano de habilitacao PHP → Java

Status: planejado (2026-09-28). Nenhuma implementacao iniciada; este documento e o
contrato de escopo do primeiro ciclo. Progresso e marcado em [PLAN](PLAN.md)
secao P7; evidencias futuras em [VALIDATION](VALIDATION.md) e
[MCP-COPILOT-EVIDENCE](MCP-COPILOT-EVIDENCE.md).

## Objetivo e tese

Habilitar o perfil `standard` para um par PHP (fonte) → Java (alvo). O motor de
garantia e agnostico de linguagem: ele congela uma referencia, captura os dois
lados ao vivo e compara comportamento observavel com fail-closed. O trabalho real
esta em tres lacunas: modo servidor gerenciado (apps donos da propria porta),
vocabulario de observacao sem browser (se a superficie for API pura) e um gate
de aceitacao proprio, no padrao P4/P5/P6.

## Decisoes em aberto (bloqueiam P7.2 em diante)

1. Superficie de observacao do piloto: UI web renderizada pelo servidor, API pura
   ou hibrida. UI ja funciona com Playwright nos dois lados; API pura exige P7.3.
2. Stack alvo: Spring Boot (JAR auto-servido) ou servlet leve (Javalin/Jetty).
   Spring Boot maximiza o valor do modo servidor.
3. Par de apps piloto: propondo um equivalente PHP→Java do exemplo
   validation-first (salvar e-mail com validacao e persistencia mockada), para
   reaproveitar o formato de regressao controlada ja conhecido.
4. Perfil restrito (briefs) para Java: fora do primeiro ciclo (ver Nao-objetivos).

## Fases

### P7.1 Spike do par de apps (M)

- Par PHP→Java minimo com a mesma superficie observavel; `commands` declarados
  (`build`/`serve`/`reset`/`test`), `reset: COMMANDS` para estado.
- Rodar `prepare-migration` e `verify-migration` manualmente e documentar o que
  passa, o que falha e o que e apenas desconforto.
- Aceite: `MIGRATION_PREPARATION: PASS`, fonte `STABLE` em `sourceRuns`, e um
  veredito honesto em pelo menos 1 cenario (PASS/FAIL/INCONCLUSIVE documentado).
- Depende de: decisao de superficie (1). Entrega: relatorio de gaps anexado aqui.

### P7.2 Modo servidor gerenciado (L)

- Fechar o item aberto "SSR/custom server" do [STATUS](STATUS.md): o schema ja
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
- Aceite: 5/5 testes de aceitacao registrados em [VALIDATION](VALIDATION.md).

### P7.6 Piloto assistido e CI (S/M)

- Ciclo completo via Copilot+MCP (uma "Session D" em MCP-COPILOT-EVIDENCE).
- Toolchains PHP + JDK na matriz CI (3 SOes), budget de tempo de build,
  hygiene de portas dos runners.
- Aceite: sessao `COMPLETE`/`PASS` dirigida pelo agente + CI verde.

## Nao-objetivos do primeiro ciclo

- Adaptadores de analise estatica (php-parser/JavaParser): inventario manual
  basta; o oraculo nao depende de discovery.
- Briefs do perfil restrito emitindo patches Java (contrato de patch hoje e
  TS/TSX): operar apenas no perfil standard.
- SSR/proxy/HTTPS completos alem do minimo do piloto; migracao de banco real
  (usar `reset: COMMANDS` sintetico).
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

## Definition of Done (P7)

1. Exemplo PHP→Java versionado e documentado (README no padrao dos exemplos).
2. P7.5 verde com evidencia em VALIDATION.md; negativas comprovadas.
3. P7.6 gravado (Session D) e CI verde na matriz.
4. STATUS.md atualizado: P7 entregue com limites declarados.
5. Decisoes (1)-(4) registradas como resolvidas neste documento.
