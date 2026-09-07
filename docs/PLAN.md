# Plano de implementacao - validacao primeiro

Atualizado: 2026-09-07. P1/P2 concluidas como biblioteca; P3 parcial com preflight,
checks nativos, builds estaticos e captura de suite com reset, sem verificacao comportamental
consolidada. Autoridade: [RFC v0.3](RFC.md).
Inventario entregue: [STATUS.md](STATUS.md). Nao confundir decisao com entrega.

## Objetivo e ordem

Uma sessao do assistente prepara, migra, verifica e corrige uma pagina dentro de
um React existente. O harness entrega evidencia independente, sem exigir que o
usuario opere contratos, briefs e JSONs intermediarios.

Ordem: P0 -> P1 -> P2 -> P3 -> P4 -> P5 -> P6. Concluir o cinema antes de novas
extensoes genericas. P1-P4 devem usar fixtures pequenas para validar integracao
incremental; nao esperar o produto inteiro para executar o primeiro comparador.

| Etapa | Estado | Evidencia de conclusao |
| --- | --- | --- |
| P0 - Realinhar documentos | Concluido | 21 documentos/49 links conferidos; hook 8/8; VALIDATION.md |
| P1 - Contratos de operacao e referencia | Concluido | Configuracao/relatorio/adaptacao e lifecycle da referencia implementados e testados |
| P2 - Precisao da comparacao | Concluido | Valores, assertivas por unidade/checkpoint, bindings aplicados, read-back de persistencia e repetibilidade source/source |
| P3 - Verificacao consolidada | Parcial | Checks, builds e captura de suite com reset/estabilidade; faltam referencia/comparacao/CLI integradas |
| P4 - Iteracao autonoma | Pendente | Reparos sem brief, historico persistente e limites respeitados |
| P5 - Cinema ponta a ponta | Pendente | Sessao real, relatorio final e regressao React |
| P6 - Componente e varias unidades | Pendente | Host de componente e regressao integrada |

Commits de implementacao (2026-09-07): P1/P2 em `c4f319b`; incremento P3 em
`5079579`; servidores estaticos em `378d730`. A retomada seguinte acrescenta reset
e captura de suite, detalhados abaixo. Commit nao fecha itens pendentes; P3 continua parcial.

## P0 - Documentacao e transicao

- [x] Revisar o desenho com o responsavel: agente conduz; harness verifica.
- [x] Substituir RFC v0.2 por v0.3 e distinguir padrao proposto de restrito existente.
- [x] Definir criterios de sucesso, limites e milestones neste plano.
- [x] Concluir reconciliacao de todos os documentos e handoff do cinema.
- [x] Conferir links, regras contraditorias, diff e compatibilidade dos agentes restritos.

Evidencia P0: VALIDATION.md, secao Documentation transition checks. Somente Markdown
alterado; 21 documentos, 49 links locais, frontmatter valido e hook 8/8 PASS.
P0 foi somente documental. O primeiro incremento de codigo da P1 esta descrito abaixo.

Remover roteiros obsoletos, preservar pesquisa util e evidencias historicas.
Nao alterar contratos, cenarios, politica ou candidatos como parte desta etapa.

## P1 - Configuracao, referencia e resultado

Pacotes principais: core, engine, quality-gates; contrato de CLI em cli.

- [x] Definir schema versionado de configuracao: raizes, escopo, comandos/cwd,
  URLs, cenarios/bindings, dados/reset, criterios, checks e limite de tentativas/tempo.
- [x] Definir referencia versionada com hashes de origem, arquivos relevantes
  inclusive nao rastreados, fixtures, cenarios, politica e ambiente.
- [x] Representar separadamente preservacao observada, requisitos e diferencas
  intencionais. Contrato formal opcional no padrao; sem autoaprovacao de contratos.
- [x] Definir relatorio agregado PASS/FAIL/INCONCLUSIVE, diagnosticos publicos
  seguros, cobertura declarada, revisoes/builds e caminhos de evidencia.
- [x] Criar adaptacao explicita dos resultados atuais; manter schemas/CLI v0.2
  e perfil restrito compativeis, sem mapear apply PASS para sucesso da migracao.
- [x] Implementar verificacao de alteracoes da referencia: adicoes versionadas;
  enfraquecimento de criterios exige decisao humana, nao recaptura silenciosa.

Aceite: testes de schema, faltas de cenario/check obrigatorio, referencia obsoleta,
alteracao de criterio, contrato adulterado e agregacao parcial nunca produzem PASS.
Nao chamar configuracao JSON ilustrativa de API disponivel antes desses testes.

Primeiro incremento: core/migration-config.ts, core/migration-report.ts e
quality-gates/migration-report.ts, com tests/migration-report.test.mjs. Hash da
configuracao inclui criterios/bindings/comandos. Agregacao separa preservacao,
requisitos e checks; evidencias ausentes, duplicadas ou de outra identidade nunca
passam. Adapter legado nao promove igualdade de shapes nem apply PASS a sucesso.

Segundo incremento: core/migration-reference.ts e engine/migration-reference.ts,
com tests/migration-reference.test.mjs. `collectMigrationReference` le os bytes reais
da arvore de trabalho (arquivos declarados de origem/destino, trabalho protegido do
destino, fixtures dos cenarios e contrato critico aprovado), recusa symlink, escape,
arquivo ausente e excesso de tamanho, e registra revisao best-effort de `.git` ou
`UNVERSIONED`. `verifyMigrationReference` reconfere esses insumos: origem/fixtures/
protegidos alterados marcam STALE, criterio ou referencia adulterada marcam
UNVERIFIABLE, e mudanca no candidato permanece informativa. Nova versao da referencia
classifica adicao, adaptacao de binding e atualizacao de insumo automaticamente, mas
enfraquecimento exige `ownerDecisionReference` explicito (ReferenceWeakeningError).
O relatorio passou a consumir essa verificacao: contrato critico so deixa de emitir
CRITICAL_CONTRACT_UNVERIFIED com referencia VERIFIED e digest igual ao configurado, e
`referenceStatus` distingue DECLARED de VERIFIED/STALE/UNVERIFIABLE.

Limites daquele incremento P1: APIs de biblioteca. Hashes detectam
inconsistencia; nao autenticam origem nem impedem mutacao do mesmo usuario.
`sourceObservations` continua declarado pelo chamador: sem execucoes repetidas a
verificacao fica UNVERIFIABLE (SOURCE_OBSERVATIONS_MISSING), porque coletar
estabilidade e trabalho da P3. Nenhuma migracao foi verificada ou aprovada por isto.
P2, descrita abaixo, completou a comparacao de valores/estado como biblioteca.

Verificacao registrada em VALIDATION.md: build PASS; suite unit/CLI 110/110 em
execucao serializada; tests/migration-reference.test.mjs 8/8; smokes e diff-check PASS.
Browser/pilotos nao reexecutados nestes incrementos de biblioteca.

## P2 - Comparar comportamento relevante

Pacotes: equivalence-validator, trace-sanitizer, scenario-runner, core.

- [x] Acrescentar comparacao de valores selecionados de request/response/estado,
  incluindo numeros, booleanos, strings, arrays e ausencia versus null.
- [x] Preservar privacidade: comparar internamente/por representacao protegida;
  diagnostico estrutural sem dados reais. Dado omitido necessario = inconclusivo.
- [x] Assertivas semanticas por unidade/checkpoint: erros, valores de campos,
  disabled/loading, ausencia de envio invalido e resultados de callbacks.
- [x] Bindings explicitos por aplicacao para rota/controle/escopo visual, sem
  mudar a acao ou esconder um controle ausente. Adaptacao versionada e reexecutada.
- [x] Diferenciar estrutura e valor, mock e persistencia: request correto mais
  read-back em backend de teste quando persistencia fizer parte do criterio.
- [x] Verificar repetibilidade source/source com reset e politica explicita.
  Nao deduzir volatilidade automaticamente de qualquer divergencia observada.

Aceite: mutacoes intencionais detectam valor errado com mesmo tipo, campo omitido,
booleano invertido, validacao ausente, rota errada e callback incorreto. Diferencas
permitidas do shell React nao reprovam a unidade; erro acessivel critico nao fica
escondido em WARNING global. Probes de vazamento e referencia instavel falham com
diagnostico seguro. Preservar regressões atuais de requests independentes/causalidade.

Primeiro incremento: equivalence-validator/values.ts com comparacao de valores de
payload e corpo de resposta, mais projecoes estruturais em network/dimensions e
core/schemas. Detecta valor errado do mesmo tipo, tipo trocado, campo ausente ou
extra, ausencia versus null, ordem e tamanho de array, tanto no request quanto na
resposta. Diagnostico traz somente caminho estrutural e tipo; navegacao, estado e
ARIA passaram a relatar rota segura, chave/classificacao da diferenca e papeis, sem
valores observados, pseudonimos ou query strings. `requiredValueFields` nao observavel
nos dois lados gera VALUE_EVIDENCE_OMITTED, que o adaptador mapeia para INCONCLUSIVE.

Compatibilidade: comparacao de valores e opt-in no perfil v0.2
(`parseValidationPolicy` mantem shape-only) e ligada por `migrationComparisonPolicy`
no perfil padrao; a configuracao padrao nao pode desligar criterios de comparacao.
Campos volateis declarados sao podados em qualquer profundidade nas projecoes de
valor, para nao virarem divergencia nem mudar rotulos causais.

Limites do primeiro incremento: comparacao posicional de arrays; valores dependem do
que a sanitizacao retem, portanto campo obrigatorio removido resulta inconclusivo.

Segundo incremento: core/unit-assertion.ts e equivalence-validator/assertions.ts.
Requisitos da configuracao podem carregar uma assertiva verificavel por checkpoint
(`AFTER_STEP` ou `SCENARIO_END`) com escopo semantico da unidade: presenca/ausencia
de no com papel/nome, estados disabled/invalid/checked/expanded/pressed/selected,
texto de campo, request proibido, request obrigatorio com campos de payload,
mutacao de storage e navegacao. Avaliacao por lado: assertiva obrigatoria violada no
destino bloqueia por autoridade propria, sem depender de ariaSeverity global; escopo
nao encontrado, checkpoint sem captura ou captura vazia resultam NOT_EVALUABLE
(INCONCLUSIVE, nunca aprovacao); origem que nao satisfaz o requisito e divulgada como
INFORMATIONAL em vez de reprovar o destino. Diferenca so no shell do destino nao
reprova a unidade. Diagnostico traz id, codigo de motivo e papel declarado, nunca o
texto observado. `assertionRequirementStatuses` mapeia resultados do destino para
status de requisito do relatorio, e a assertiva entra no digest do requisito na
referencia, portanto alterar criterio pede decisao do responsavel.

Limites: comparacao posicional de arrays; valores dependem do que a sanitizacao
retem, portanto campo obrigatorio removido resulta inconclusivo, nao aprovado.
Janela de checkpoint por passo vai da interacao ate a proxima, dependendo da drenagem
do gravador, nao de tempo de parede. Callbacks sao verificados pelos efeitos
observaveis (DOM/storage/navegacao/request); captura direta de outputs depende do host
de componente da P6. Requisito somente em prosa continua precisando de evidencia
fornecida pelo chamador.

Terceiro incremento: bindings aplicados por lado. O binding de cada aplicacao passou a
declarar tambem `unitScope`, o escopo visual da unidade, e `resolveScenarioForSide`
produz o cenario executavel daquele lado: rota de entrada, papeis/nomes efetivos dos
controles e escopo, revalidando o resultado e recusando qualquer mudanca da projecao
semantica compartilhada, que e a mesma usada no hash da referencia. O schema nao permite
que um binding expresse acao, valor, sinal de conclusao, passo desconhecido, papel
invalido ou outra origem. A avaliacao de assertivas aceita `unitScopes` por lado, com o
escopo da assertiva como padrao; escopo adaptado que nao resolve fica NOT_EVALUABLE e
controle ausente dentro do escopo continua NODE_MISSING, portanto adaptar binding nao
esconde controle. Mudanca de binding altera o hash da configuracao e e classificada como
BINDING_ADAPTATION, exigindo nova versao da referencia e reexecucao dos dois lados.

Limites: o binding e aplicado como biblioteca; ligar o cenario resolvido ao
ScenarioRunner e ao escopo das assertivas em uma execucao real e trabalho da P3.
Nomes e papeis declarados sao comparados por igualdade/inclusao normalizada, sem
heuristica de similaridade.

Quarto incremento: persistencia e repetibilidade. A claim `READ_BACK` exige que os
valores escritos voltem em uma leitura posterior do backend controlado, comparando
campos declarados do payload com campos da resposta; leitura respondida por mock
declarado resulta READ_BACK_MOCKED (NOT_EVALUABLE), porque fixture nao prova
persistencia. `discloseMockedCoverage` divulga cobertura mockada como INFORMATIONAL e o
relatorio aceita a divulgacao MOCKED_COVERAGE junto de um PASS, sem esconde-la.
`verifySourceStability` compara execucoes repetidas da origem com a mesma politica da
migracao sob o reset declarado e produz `sourceObservations` (STABLE/UNSTABLE/
NOT_COLLECTED) com hashes de execucao, que e exatamente o que a referencia versionada
exige. Diferenca bloqueante entre execucoes da origem marca UNSTABLE e lista codigos e
locais estruturais para revisao; a ferramenta nunca declara um campo volatil sozinha,
so a politica explicita do responsavel torna a origem estavel.

Limites: cobertura mockada e detectada pelos mocks declarados do cenario, nao por
introspeccao do transporte; read-back usa a ultima escrita da janela e qualquer leitura
posterior no trace; estabilidade compara apenas preservacao (rede, observaveis,
causalidade, websocket), sem contrato nem assertivas; reset e uma declaracao registrada,
nao uma verificacao de que o backend foi realmente limpo. Ligar tudo a uma execucao real
com processos, build e servidor e a P3.
Proxima tarefa: P3, uma operacao de verificacao completa.

Verificacao registrada em VALIDATION.md: build PASS; unit/CLI 132/132 serializado;
browser 13/13; ambos os smokes; pilotos deterministico e de protocolo PASS;
diff-check PASS.

## P3 - Uma operacao de verificacao completa

Pacotes: cli, engine, scenario-runner, quality-gates.

- [ ] Escolher nomes de comandos e publicar help/configuracao executavel; nao
  reaproveitar silenciosamente flags/resultados existentes com outro significado.
- [ ] Preflight de ambiente/raizes/portas/fixtures e checks da baseline antes de
  atribuir erros preexistentes a migracao. Falha preexistente nao satisfaz gate.
- [x] Executar build/typecheck/lint/testes com configuracao nativa do destino,
  substituindo o compilador isolado como gate principal do perfil padrao.
- [x] Coordenar builds declarados e servidores estaticos de SPA com portas reservadas,
  healthcheck e cleanup proprio, usando cwd/argv/timeouts e ambiente autorizado.
- [x] Servir snapshots imutaveis de builds novos e identificar os bytes servidos;
  rejeitar porta ocupada, output antigo e alteracoes durante a sessao.
- [x] Executar reset declarado antes de cada captura; rodar todos os cenarios
  nos dois lados com bindings, contextos novos e estabilidade source/source real.
- [x] Registrar capturas completas, falhas e nao executadas, ligadas ao build e
  com evidencia sanitizada; concluir cleanup antes de gravar o resultado final.
- [ ] Integrar identidade do build a referencia e ao relatorio da suite efetivamente
  executada; recusar cache de referencia invalido na operacao consolidada.
- [ ] Rodar todos os cenarios obrigatorios e regressao do destino; agregar
  checks/cobertura, requisitos, preservacao, avisos e lacunas em JSON e resumo legivel.
- [ ] Classificar problema operacional, evidencia insuficiente e regressao com
  diagnosticos localizados; reter tentativas falhas sem mascarar seu resultado.

Aceite: testes CLI/browser de multiplos cenarios, porta ocupada, build obsoleto,
timeout, falha de build/servidor, reset entre runs, cenario ausente e cleanup.
Reproduzir e resolver o problema Vite ImportMeta.env pelos comandos/configuracao
reais, sem inserir any ou alterar API protegida para agradar um gate artificial.

Primeiro incremento P3: `check-projects` com `--preflight-only`, ou execucao
autorizada de checks em fase baseline/candidate. APIs `preflightProjectChecks` e
`runProjectChecks` verificam inputs/cwd, executam argv sem shell em sequencia,
aplicam timeout/orcamento e limite de saida, encerram grupos de processos proprios
e reconferem os inputs declarados. Stdout/stderr sao contados, nunca publicados.

Falha preexistente do mesmo check e anotada, nao aprovada nem confundida com prova
da mesma causa. `PROJECT_CHECK_REPORT` nao e `MIGRATION_REPORT`: PASS aqui nao e
equivalencia. `npm run build` e `npm run lint` reais de apps/react passaram pelo
executor, sem alterar a API nem desativar checks. O gate isolado restrito fica intacto.

Pendencias apos aquele incremento: servidores/healthcheck/portas, reset executado
entre cenarios, identidade do build servido, suite source/target, checks no relatorio
de migracao e diagnosticos operacionais mais localizados. Executor POSIX/Linux/WSL,
sem sandbox; processos que escapam deliberadamente do grupo nao sao isolados.
Este comando nao captura estabilidade nem aprova referencia. Evidencia: VALIDATION.md.

Verificacao deste incremento: build PASS, unit/CLI 143/143 serializado (11 testes
novos de checks), ambos os smokes, links/diff-check PASS. Baseline real do React:
build/lint PASS e arvore limpa. Browser/pilotos nao reexecutados nesta retomada.

Segundo incremento P3: `withProjectBuildServers` (engine/build-servers.ts) executa
checks nativos e serve os dois builds estaticos somente durante um callback. A
configuracao opcional `build` declara o comando, outputDir e `cleanOutput: true`:
consentimento para remover aquele diretorio exclusivamente gerado antes do build.
As duas portas sao reservadas antes de qualquer limpeza/execucao; porta ocupada
recusa sem reutilizar servidor ou encerrar processo alheio. Outputs nao podem
sobrepor inputs/escopo/fixtures/contrato; links e artefatos sensiveis sao recusados.

`SERVED_BUILD` registra UUID, origem, hashes de configuracao/inputs e manifesto dos
arquivos. O servidor entrega snapshot em memoria, no-store e cabecalho de build;
healthcheck reconfere identidade. Mutacao de inputs/output invalida o retorno,
mesmo que os bytes em memoria continuem corretos. Sucesso, erro, abort e timeout
encerram os servidores proprios. Metadados de build entram no hash de ambiente
da referencia; configuracoes anteriores sem build mantem a projecao anterior.

Limites: biblioteca para SPA estatica em HTTP loopback, sem SSR/dev-server/proxy;
nao executa reset/cenarios nem emite MIGRATION_REPORT. O callback deve usar contextos
novos, respeitar AbortSignal e fechar seus recursos. Hashes cobrem inputs declarados,
nao autenticam o build nem isolam codigo hostil. Nao preserva output gerado anterior.
Verificacao: build PASS; 11/11 unitarios novos e 1/1 teste Chromium focado; regressao
completa 168/168 (154 unit/CLI + 14 browser), ambos os smokes e diff-check PASS.
Teste Chromium novo cobre ambos os lados e viewports desktop/mobile. VALIDATION.md
registra comandos/limites; pilotos separados e builds reais do Cinema nao reexecutados.

Terceiro incremento P3: `captureProjectSuite` coordena builds/servidores, reset,
capturas e estabilidade. Executa `limits.sourceRuns` vezes cada cenario na origem
e uma no destino, incluindo opcionais. `runProjectReset` reaproveita o executor
nativo com autorizacao, cwd, timeout, cleanup e reconferencia de inputs. Um reset
com erro impede aquela captura, sem esconder os outros cenarios; isolamento de
fixtures significa contexto novo, nao limpeza presumida de backend externo.

O runner aplica bindings/ambiente e confere o cabecalho do build na navegacao real
apos o seed de storage. Recebe AbortSignal, fecha apenas seu contexto e preserva
browser fornecido pelo chamador. A suite usa um diretorio publico novo e exclusivo,
fora de apps/fixtures/contrato, registra inventario inicial, resultado de cada run
e `capture-suite.json` final. Hashes de trace/binding e identidade do build ligam
as capturas ao que foi executado. Raw fica somente em memoria; chave efemera comum
serve aos dois lados nesta invocacao. Nao ha cache/comparacao entre invocacoes.

`CAPTURE_SUITE.COMPLETED` significa captura completa, nao equivalencia: origem
instavel pode ter todas as capturas completas e fica explicitamente UNSTABLE.
Falhas operacionais/mutacao de inputs ou build tornam a suite INCONCLUSIVE, mesmo
com capturas anteriores completas. Ainda nao produz MIGRATION_REPORT, nao aplica
assertivas ao destino e nao emite/atualiza uma referencia. Nao reaprova criterios.

Verificacao focada: build PASS, 4/4 testes de reset/carregamento e 6/6 browser novos.
Playwright so e carregado quando a captura e solicitada, sem custo nos outros comandos.
Backend sintetico com estado prova reset antes de cada uma de seis capturas;
sem reset, a origem e detectada como instavel. Regressao final 178/178 PASS
(158 unit/CLI + 20 browser), build, ambos os smokes e diff-check PASS.
Pilotos separados e builds reais do Cinema nao reexecutados. VALIDATION.md registra
tambem a execucao anterior e a verificacao apos adiar o carregamento do navegador.

Proxima tarefa P3: vincular esta evidencia a uma referencia versionada valida,
comparar preservacao/requisitos/regressao do destino, agregar checks e diagnosticos
seguros e publicar uma operacao CLI com JSON e resumo legivel. Nenhum candidato
do Cinema foi alterado por estes incrementos.
Ao integrar a referencia, a estabilidade global deve cobrir o inventario inteiro,
nao apenas copiar as observacoes do primeiro cenario; capturas ausentes nao aprovam
essa referencia. Artefatos de outra invocacao nao compartilham a chave efemera.

## P4 - Assistente ponta a ponta e reparos

Pacotes: cli/engine/quality-gates; AGENTS.md, manual e agentes/hook.

- [ ] Habilitar perfil padrao explicitamente, com edicao normal dentro do escopo
  e verificacao de diff (novos/removidos/links/arquivos protegidos/alteracoes do usuario).
- [ ] Liberar leitura de codigo relevante e edicao de CSS/assets/testes autorizados,
  sem manifest/brief obrigatorio. Dependencias novas respeitam a especificacao.
- [ ] Criar instrucao/agente padrao que prepare e opere comandos; manter os dois
  agentes restritos e seu hook sem ampliar permissoes por acidente.
- [ ] Diagnosticar violacoes como defeitos de implementacao quando os criterios
  estao claros; nao encaminhar campo obrigatorio ausente para revisao do contrato.
- [ ] Persistir orcamento, tentativas e ausencia de progresso entre invocacoes.
  Permitir correcao semantica dentro do escopo, nao apenas metodo HTTP.
- [ ] Suportar extensao de cobertura e adaptacao de binding conforme RFC, com
  nova referencia e reexecucao; pedir revisao para reducao de criterios/novo desvio.
- [ ] Exigir suite final completa no mesmo candidato; documentar motivos reais
  de intervencao humana e separar manutencao do harness de reparo do candidato.

Aceite: sessao/fixture de integracao corrige valores, validacao e navegacao;
recusa alteracao de criterios/escopo, nao reinicia contador, para sem progresso e
nao declara sucesso inconclusivo. Suite restrita e pilotos antigos continuam verdes.

## P5 - Cinema como primeiro caso de uso

Entradas locais: migrations/cinema/SPEC.md e HANDOFF.md. Apps foram criadas para
o exercicio; nao sao evidencia de aplicacao de terceiros. Nenhuma pagina foi migrada.

- [ ] Registrar adocao operacional do padrao apos P1-P4, confirmar baselines e
  reconciliar configuracao nova com o escopo existente; nao ampliar arquivos por inercia.
- [ ] Reaproveitar/revalidar tres cenarios e nove capturas como evidencia historica,
  sem chama-las de referencia v0.3. Propostas REVIEW antigas continuam nao aprovadas.
- [ ] Completar cobertura exigida: valores salvos, 401, 400 no PUT, erros de
  carga/gravação, limites dos campos, estado de envio e reenvio conforme SPEC.
- [ ] Executar uma sessao real: preparar, implementar FilmeEditar, integrar rota,
  comparar, reparar e entregar. Uma nova conversa nao e criterio de aceite.
- [ ] Injetar regressões controladas de valor, validacao e navegacao; demonstrar
  falha -> correcao -> sucesso sem enfraquecer referencia.
- [ ] Rodar login/lista/sessao como regressao; revisar codigo/acessibilidade e
  registrar relatorio, revisao/build, cobertura e limitacoes. Commit conforme autorizacao.
- [ ] Medir intervenções humanas e trabalho manual de artefatos; ajustar UX antes
  de ampliar adapters. Nenhuma pausa obrigatoria apenas para JSON/brief/contrato formal.

Aceite de usabilidade: o usuario fornece escopo/decisoes reais, o agente preenche
detalhes e conduz execucao. Registrar tempo de preparo/verificacao, tentativas e
motivos das pausas; nao prometer ganho percentual sem comparacao medida.

## P6 - Componente e aplicacao incremental

- [ ] Demonstrar componente sem rota via hosts autorizados, props/callbacks,
  teclado, estados e integracao com design system existente.
- [ ] Demonstrar duas ou mais unidades ordenadas por dependencia, com verificacao
  por unidade e suite integrada final da mesma revisao do destino.
- [ ] Atualizar manual/template com exemplos medidos; somente entao declarar
  suporte operacional aos tres casos de uso, mantendo limites de cobertura.

## Adiado, nao requisito do primeiro ciclo

- Descoberta field-level inject() e novos codemods de forms/streams/DI.
- OpenAPI condicional/dependent* e extracao generica de frameworks de testes.
- Docker contra imagem real e demonstracao brief-only do perfil restrito.
- Novas extensoes de SW/WS, causalidade, criptografia/backup/anchoring.

Recursos ja existentes nao serao apagados apenas para reduzir a lista. Corrigir
um defeito neles se bloquear o caso real, sem reabrir uma expansao geral da RFC.

## Protocolo de progresso e verificacao

- Marcar [x] apenas com teste/artefato/revisao registrado; decisao documental nao
  fecha tarefa de codigo. Usar pendente, em execucao ou bloqueado com causa concreta.
- A cada etapa: build antes de testes que importam dist, testes focados e suite
  proporcional ao impacto. Antes de P5: build, unitarios/CLI, browser, smokes e pilotos.
- Revisoes de protocolo invalidam briefs que incluem AGENTS.md; emitir novos se
  o perfil restrito for retomado, sem editar hashes antigos.
- Handoff: etapa, perfil, revisoes testadas, comandos/resultados, pendencias e
  proxima acao. Nao retomar listas obsoletas de docs removidos.
- Nenhum merge/push/remocao da origem sem pedido explicito. apps/ e migrations/
  sao ignorados no Git do harness; providenciar versionamento autorizado separado.
