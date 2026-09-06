# Manual de migracao com Copilot

Atualizado: 2026-09-06.

**Estado atual:** manual, especificacao e agentes disponiveis. As correcoes da
auditoria estao implementadas e verificadas na arvore atual (build, 92/92 testes
unitarios/CLI, 13/13 no Chromium, smokes e os dois pilots). O que nunca foi
executado e o proprio fluxo desta pagina contra um Angular e um React reais.
Consulte `STATUS.md` e `REVIEWS.md` antes de iniciar uma migracao real. Este
documento nao declara o harness pronto para producao.

## 1. O que este fluxo faz

O Copilot usa suas capacidades para entender e transformar o codigo. O harness
delimita a unidade, emite um brief, verifica a submissao e compara comportamentos
observados nas duas aplicacoes. Ele nao chama a API de um modelo.

Ha dois caminhos:

- **Componente ou pagina:** migrar uma unidade e integra-la ao React existente.
- **Aplicacao:** inventariar paginas/componentes/dependencias e repetir o mesmo fluxo
  por unidade. Nao existe um comando que converta uma aplicacao Angular arbitraria
  inteira com garantia automatica.

O destino nao e uma aplicacao React nova. Preserve seu roteador, design system,
autenticacao, cliente HTTP, estado, organizacao e funcionalidades existentes.

## 2. Organizacao da pasta

```text
migration-harness/
  AGENTS.md
  packages/                    # harness; nao alterar durante a migracao
  .github/agents/              # agentes de preparacao e transformacao
  scripts/
    copilot-boundary-hook.mjs  # hook PreToolUse de fronteira
  docs/
    COPILOT-MIGRATION.md
    templates/MIGRATION-SPEC.md
  apps/
    angular/                   # clone independente, com seu proprio .git
    react/                     # clone independente, com seu proprio .git
  migrations/
    cliente/
      SPEC.md                  # especificacao preenchida para esta migracao
      units.md                 # inventario e checklist por unidade
      scenarios/
      fixtures/                # somente dados sinteticos
      contracts/               # documentos revisados pelo responsavel
      policy.json
  artifacts/
    cliente/
      customer-profile/        # evidencias publicas da unidade
```

`apps/`, `migrations/` e `artifacts/` sao ignorados pelo Git do harness. Os clones
continuam com historicos independentes. Versione as especificacoes/evidencias
permitidas em um repositorio de acompanhamento aprovado pela equipe; nao dependa
apenas destas pastas locais. Nunca versione raw traces, chaves ou credenciais.

O responsavel pode preparar os clones assim, substituindo as URLs reais:

```bash
git clone <URL_ANGULAR> apps/angular
git clone <URL_REACT> apps/react
git -C apps/angular status --short
git -C apps/react status --short
git -C apps/react switch -c migration/customer-profile
```

Nao clone por cima de diretorios existentes. Nao descarte alteracoes locais. Commits
da migracao sao feitos no React com `git -C apps/react ...`, nao no harness.

## 3. Preparacao e responsabilidades

1. Instale as dependencias do harness e Chromium. Se `pnpm` nao estiver no PATH,
   use `npx --yes pnpm@10.15.0` em seu lugar.
2. Instale as dependencias de cada aplicacao com o gerenciador/lockfile do proprio
   projeto. Nao troque ferramentas nem atualize dependencias incidentalmente.
3. Preencha a especificacao de `docs/templates/MIGRATION-SPEC.md` em
   `migrations/cliente/SPEC.md`. Defina escopo, URLs, rotas, criterios e arquivos.
4. Registre comandos reais de build, typecheck, lint, testes e inicializacao de ambas
   as aplicacoes. O responsavel deve revisar comandos que executam codigo do projeto.
5. Inicie Angular e React em portas diferentes, usando apenas ambiente de teste,
   contas de teste e dados sinteticos. O harness nao inicia os seus dev servers.
6. Crie cenarios que possam executar com os mesmos seletores e passos nas duas
   aplicacoes. Use mocks/fixtures revisados quando necessario.
7. Um responsavel humano revisa os invariantes e aprova o contrato. O agente que
   transforma codigo nao pode mudar o oraculo para fazer o resultado passar.

```bash
npx --yes pnpm@10.15.0 install --frozen-lockfile
npx --yes pnpm@10.15.0 exec playwright install chromium
npx --yes pnpm@10.15.0 build
```

No WSL, raw traces e chaves ficam no filesystem Linux nativo, fora do workspace.
Permissoes 0700/0600 nao isolam o assistente executado pelo mesmo usuario: a
disciplina de nao ler dados privados continua obrigatoria.

## 4. Especificacao para o Copilot

Use `docs/templates/MIGRATION-SPEC.md` como contrato de trabalho preenchido, nao
apenas uma frase como "converta Angular para React". O arquivo distingue:

- preparacao do escopo e das evidencias;
- transformacao estritamente limitada a um brief emitido;
- integracao e verificacao das funcionalidades existentes;
- aprovacao humana e decisao de merge.

Para iniciar a preparacao, referencie os arquivos no contexto do Copilot e envie:

```text
Leia AGENTS.md, docs/COPILOT-MIGRATION.md e migrations/cliente/SPEC.md.
Estamos na fase de preparacao, nao de transformacao.
Confira os repositorios e a especificacao; inventarie as unidades e os pontos de
integracao do React existente. Atualize migrations/cliente/units.md com feito,
pendente e bloqueado. Proponha os cenarios e os arquivos de cada unidade.
Nao leia raw traces/segredos, nao modifique o Angular, nao altere o harness, nao
aprove contratos e nao implemente candidatos antes de haver um brief autorizado.
```

**A preparacao precisa de autorizacao expressa para ler os arquivos listados na
especificacao.** As regras brief-only de `AGENTS.md` continuam valendo para a fase
de transformacao. Nao use uma tarefa de migracao como permissao para manter o harness.

Quando a unidade estiver preparada, inicie uma conversa de transformacao com o
brief e este comando de trabalho:

```text
Execute a fase de transformacao da unidade indicada no brief fornecido.
Leia AGENTS.md e somente o brief, seus contextFiles e allowedFiles, alem dos
resultados publicos emitidos pelo harness para esta unidade.
Use suas capacidades para produzir a implementacao React de acordo com o contrato
e com os padroes do destino. Nao crie outra aplicacao React.
Nao edite os arquivos candidatos diretamente: produza submission.json no caminho
publico autorizado e use apply-patch. O beforeHash deve continuar igual ao brief.
Execute a verificacao indicada, registre os resultados emitidos e pare diante de
escopo insuficiente, baseline alterada ou uma necessidade de revisao do contrato.
Nao se autodeclare equivalente nem pronto para merge.
```

Para comprovar o DoD de uma sessao real brief-only, registre a conversa limpa,
briefId, submissao e resultados. Uma conversa que ja leu todo o harness ou todo o
projeto nao deve ser apresentada como essa prova.

## 4.1 Agentes e hook de fronteira

As duas fases existem como agentes do Copilot em `.github/agents/`, com
ferramentas restritas e um hook `PreToolUse` compartilhado
(`scripts/copilot-boundary-hook.mjs`):

- `migracao-preparacao`: leitura e busca, escrita somente em `migrations/`, sem
  execucao de comandos.
- `migracao-transformacao`: sem busca no workspace (procurar codigo fora do brief
  e justamente o que a fase proibe), leitura restrita ao brief/`contextFiles`/
  `allowedFiles`/`AGENTS.md`/artefatos da unidade, escrita apenas do
  `submission.json` na raiz de artefatos, terminal liberado para `apply-patch` e
  verificacao mas nao para atos do oraculo.

Antes de abrir a conversa de transformacao, aponte o brief da vez:

```bash
echo artifacts/cliente/customer-profile/brief.json > .harness-brief-path
```

O hook le esse caminho (ou `HARNESS_BRIEF`) e deriva a fronteira do brief
emitido. Sem brief, sem fase declarada ou com entrada ilegivel ele recusa tudo.
Cada decisao vira uma linha JSONL em `artifacts/copilot-boundary.log`, que serve
como evidencia de que a fronteira se manteve durante a sessao.

Limites honestos: hooks declarados em arquivos de agente sao recurso Preview do
VS Code e exigem `chat.useCustomAgentHooks` habilitado; sem isso os agentes
valem como instrucao, sem imposicao mecanica. O hook filtra chamadas de
ferramenta do assistente, nao acessos do mesmo usuario por fora delas, e nao
substitui `AGENTS.md`: uma leitura que ele nao bloqueia continua proibida se a
especificacao nao a autorizou.

## 5. Fluxo de uma unidade

Os comandos abaixo sao modelos. Ajuste nomes/arquivos a descoberta real; use a mesma
raiz de artefatos da unidade durante todo o ciclo. Execute-os na raiz do harness.

### Descobrir e planejar

```bash
node packages/cli/dist/index.js discover \
  --source-root apps/angular/src \
  --entrypoint 'app/customer/customer-profile.component.ts#CustomerProfileComponent' \
  --out artifacts/cliente/customer-profile/discovery.json

node packages/cli/dist/index.js plan \
  --source-root apps/angular/src \
  --entrypoint 'app/customer/customer-profile.component.ts#CustomerProfileComponent' \
  --out artifacts/cliente/customer-profile/plan.json
```

O entrypoint e `caminho-relativo-ao-source-root#NomeDoSimbolo`. Em uma aplicacao com
varios componentes ele precisa ser explicito. Revise dependencias nao resolvidas;
um plano emitido nao prova que o codemod suporta toda a unidade.

### Capturar evidencias da origem

Exemplo de cenario a adaptar aos nomes acessiveis reais das duas aplicacoes:

```json
{
  "scenarioId": "customer-profile-save",
  "unitId": "CustomerProfileComponent",
  "name": "Salvar perfil",
  "description": "Atualizacao do perfil com dados sinteticos",
  "entryUrl": "http://localhost:4200/customers/123/edit",
  "testDataProfile": "standard",
  "preconditions": {
    "mockInitialApiResponses": [{
      "urlPattern": "**/api/customers/123",
      "method": "PUT",
      "statusCode": 200,
      "fixturePath": "../fixtures/customer-saved.json"
    }]
  },
  "steps": [
    { "stepId": "email", "action": "fill", "targetRole": "textbox", "targetName": "Email", "inputValue": "updated@example.test" },
    { "stepId": "save", "action": "click", "targetRole": "button", "targetName": "Salvar",
      "completionSignal": { "type": "RESPONSE_RECEIVED", "responseUrlPattern": "/api/customers/123", "responseMethod": "PUT", "timeoutMs": 10000 } }
  ],
  "completionSignal": { "type": "LOCATOR_VISIBLE", "targetRole": "status", "timeoutMs": 10000 }
}
```

A fixture JSON deve existir e representar uma resposta de teste revisada. Prepare
tambem os dados de carregamento inicial. Veja outro exemplo executavel em
`examples/angular-react-pilot/scenario.json`.

O `run` atual troca a origem (host/porta), mantendo o caminho do `entryUrl`.
Passar outro caminho dentro de `--target-url` nao remapeia a rota inicial. Quando as
rotas diferirem, prepare uma rota host/alias de teste aprovada no destino ou trate o
caso como bloqueio de adaptacao. Nao simule equivalencia comparando telas diferentes.

```bash
node packages/cli/dist/index.js trace \
  --scenario migrations/cliente/scenarios/customer-profile.json \
  --base-url http://localhost:4200 --runs 3 \
  --policy migrations/cliente/policy.json \
  --artifact-root artifacts/cliente/customer-profile
```

O comando imprime os caminhos dos traces sanitizados. O responsavel usa esses
caminhos para sintetizar e revisar o contrato; nao os envia inteiros ao agente.
O brief utiliza uma projecao estrutural. Fixtures de mocks sao relativas ao arquivo
do cenario, nao ao diretorio do shell.

```bash
node packages/cli/dist/index.js synthesize \
  --unit-id CustomerProfileComponent \
  --input '<trace-sanitizado-1>,<trace-sanitizado-2>,<trace-sanitizado-3>' \
  --out migrations/cliente/contracts/customer-profile.draft.json

node packages/cli/dist/index.js review-contract \
  --input migrations/cliente/contracts/customer-profile.draft.json \
  --out migrations/cliente/contracts/customer-profile.review.json
```

**Pausa humana:** observar tres vezes nao transforma um comportamento em requisito
obrigatorio. O revisor incorpora as obrigacoes reais, revisa evidencias e decide a
aprovacao. Apenas depois dessa revisao:

```bash
node packages/cli/dist/index.js approve-contract \
  --input migrations/cliente/contracts/customer-profile.review.json \
  --approved-by '<identidade-do-revisor-real>' \
  --out migrations/cliente/contracts/customer-profile.approved.json
```

O contrato de um brief deve corresponder ao conjunto de cenarios fornecido. Para
varios cenarios, capture cada um, sintetize com as evidencias adequadas e informe
os caminhos separados por virgula ao emitir o brief.

### Preparar a politica

Exemplo minimo de estrutura, a ser revisado para a aplicacao:

```json
{
  "allowedOrigins": ["http://localhost:4200", "http://localhost:3000"],
  "sanitization": {
    "allowedPayloadKeys": ["email"],
    "allowedStorageKeys": ["profile.saved"]
  },
  "assistant": {
    "allowedPackages": ["react", "react-router-dom"],
    "targetConventions": {
      "framework": "React existente; preservar arquitetura, auth e design system",
      "scope": "CustomerProfileComponent"
    },
    "maxBriefBytes": 262144,
    "maxSubmissionBytes": 2000000,
    "typecheck": true,
    "lint": true
  }
}
```

Permita somente pacotes ja aprovados para o destino e origens realmente necessarias.
Campos de payload/storage sao negados por padrao. Nao libere dados ou enfraqueca
comparacoes somente para obter PASS.

### Emitir o brief para o React existente

```bash
node packages/cli/dist/index.js brief \
  --unit-id CustomerProfileComponent \
  --unit artifacts/cliente/customer-profile/discovery.json \
  --plan artifacts/cliente/customer-profile/plan.json \
  --contract migrations/cliente/contracts/customer-profile.approved.json \
  --scenario migrations/cliente/scenarios/customer-profile.json \
  --source-trace '<um-trace-sanitizado-da-unidade>' \
  --policy migrations/cliente/policy.json \
  --source-root apps/angular/src --candidate-root apps/react \
  --candidate-files src/features/customer/CustomerProfile.tsx,src/app/routes.tsx \
  --context-files apps/react/package.json,apps/react/src/components/Button.tsx \
  --artifact-root artifacts/cliente/customer-profile --out brief.json
```

`--candidate-files` delimita os unicos arquivos gravaveis, relativos ao clone React.
Inclua a rota/arquivo de integracao quando ela precisar mudar. Nao permita o clone
inteiro apenas para evitar uma recusa.

`--context-files` fornece arquivos existentes de leitura, explicitamente listados
dentro das raizes Angular/React: exemplos de componentes, cliente HTTP, estilos,
templates, package.json e convencoes. Eles sao protegidos por hash. Arquivos do
destino nesse contexto podem ser dependencias de imports relativos, sem se tornarem
gravaveis. Inclua a cadeia de leitura/imports que realmente sera necessaria.

Nao coloque o mesmo arquivo em contexto protegido e em candidatos gravaveis.
Nao inclua `.env`, chaves, node_modules, raw traces ou outros projetos.

### Submeter e aplicar

O agente entrega JSON no caminho publico autorizado:

```json
{
  "briefId": "<briefId emitido>",
  "patches": [{
    "path": "src/features/customer/CustomerProfile.tsx",
    "beforeHash": "<sha256 do brief>",
    "content": "<conteudo TypeScript/TSX completo>"
  }],
  "manifest": {
    "unitId": "CustomerProfileComponent",
    "generatedAt": "<data ISO-8601>",
    "transformer": { "kind": "LLM", "name": "copilot" },
    "mappings": [{
      "mappingId": "customer-profile",
      "source": "<simbolo da origem>",
      "target": "<simbolo do destino>",
      "preserves": ["<obrigacao do contrato>"]
    }]
  }
}
```

Os marcadores sao ilustrativos, nao valores validos para submissao literal.
O manifest registra alegacoes; nao aprova a implementacao.

```bash
node packages/cli/dist/index.js apply-patch \
  --brief artifacts/cliente/customer-profile/brief.json \
  --input artifacts/cliente/customer-profile/submission.json \
  --candidate-root apps/react \
  --artifact-root artifacts/cliente/customer-profile \
  --source-url http://localhost:4200 --target-url http://localhost:3000 \
  --next-out artifacts/cliente/customer-profile/verify-1.json \
  --out apply-1.json
```

O comando completo tambem aparece no brief. O resultado PASS significa apenas que
os gates configurados para aplicar passaram. O React deve reconstruir os bytes
aplicados antes da comparacao.

### Verificar e iterar

Execute o `next.command` do resultado com o prefixo
`node packages/cli/dist/index.js`. Ele usa o manifest arquivado pelo harness,
contrato/politica emitidos e `run --max-repairs 0`.

- Verifique **todos** os cenarios obrigatorios. O comando sugerido cobre o primeiro.
- Cada verificacao usa um novo caminho de saida; nao sobrescreva evidencias.
- Rode tambem os testes, build, typecheck e lint reais do React existente, conforme
  os comandos revisados da especificacao. Os gates isolados nao substituem o build
  do projeto nem cobrem automaticamente seus aliases/configuracoes.
- Verifique rotas e funcionalidades do destino que nao deveriam ter mudado.
- Se houver `AUTO_REPAIRABLE`, solicite um brief de reparo com os mesmos limites e
  `--repair --equivalence <verify.json> --attempt 1 --max-repairs 3`.
- O reparo automatico atual e localizado em divergencias de metodo HTTP. Outros
  problemas exigem triagem/revisao; nao force uma classificacao para continuar.
- Em `BASELINE_HASH_MISMATCH`, obtenha um novo brief autorizado. Recalcular somente
  o hash da submissao nao resolve um brief obsoleto.
- Nao troque contrato, cenario ou politica para esconder uma regressao.

O contador de tentativas e informado pelo chamador. Registre o historico em
`units.md` e respeite o limite humano; nao reinicie o contador para contorna-lo.

## 6. Aplicacao completa versus componente/pagina

**Componente/pagina:** documente props/inputs, callbacks/outputs, validacao, loading,
erro, permissao, navegacao, storage e chamadas HTTP pertinentes. Inclua no escopo os
pontos de integracao necessarios. Um componente sem rota precisa de uma rota host de
teste aprovada nas duas aplicacoes; o harness nao inventa essa montagem.

**Aplicacao completa:** primeiro inventarie rotas, componentes compartilhados,
servicos, autenticacao e estado. Organize unidades na ordem de dependencia, com
contratos/cenarios/artefatos separados. Faca a integracao progressiva no React
existente; nao apague funcionalidades preexistentes nem substitua seu shell global.
Ao terminar as unidades, rode uma suite integrada e uma regressao completa do destino.

Modelo de acompanhamento:

```markdown
| Unidade | Origem | Destino | Contrato | Brief | Aplicacao | Cenarios | Regressao React | Revisao |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| customer-profile | ... | ... | pendente | pendente | pendente | pendente | pendente | pendente |
```

Marque cada coluna com referencia de evidencia, nao apenas "feito".

## 7. Limites e encerramento

- Patches automatizados sao substituicoes TS/TSX. Alteracoes em package.json,
  lockfiles, CSS novo, assets e configuracao fora dessa fronteira exigem uma tarefa
  separada, autorizada e revisada. Nunca esconda essas alteracoes na submissao.
- Async validators, FormArray, formularios dinamicos, streams e DI complexa nao sao
  conversoes deterministicas prontas. O agente pode propor uma implementacao
  semantica limitada ao brief, mas precisa de cenarios suficientes e revisao.
- Service workers: default block; o opt-in corrigido exige encaminhamento de
  requests um-para-um com metodo/URL/payload/status correspondentes. Cache,
  reescritas de request e chamadas autonomas sao recusados. O corpo observado pela
  pagina continua sendo validado; Chromium pode omitir o corpo interno do worker.
- Requisitos condicionais OpenAPI e schemas nao representaveis ficam para revisao.
- O scanner estatico nao e sandbox. Docker nao foi validado neste ambiente. Nao
  execute comandos arbitrarios gerados pelo agente fora de uma fronteira aprovada.
- A rotacao conserva chaves antigas; poda automatica foi desabilitada para nao
  inutilizar backups. Nao remova chaves manualmente sem um plano de recuperacao.
- Se um lock sobrar apos crash, pare e peca recuperacao humana. Nao apague locks
  automaticamente nem declare rollback garantido entre arquivos apos um crash.
- EQUIVALENT vale para os cenarios e a politica executados, nao para qualquer uso
  possivel da aplicacao. Acessibilidade completa e aprovacao de contrato sao humanas.

Encerrar uma unidade exige: evidencias equivalentes em todos os cenarios previstos,
regressao do React sem falhas, contrato intacto, revisao humana, diff restrito e
checklist atualizado. Prepare um commit no React somente quando autorizado. Merge,
push e remocao do Angular dependem de decisao explicita do responsavel.
