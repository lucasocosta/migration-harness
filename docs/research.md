# Migration Harness --- Research & Execution Context

**RFC alvo:** v0.2\
**Adapter inicial:** Angular → React\
**Abordagem:** Evidence-Guided Translation Validation for
Behavior-Preserving Software Migration\
**Objetivo deste arquivo:** dar a um agente de engenharia contexto
suficiente para continuar a implementação sem redescobrir as decisões,
pesquisas, invariantes e armadilhas já identificadas.

------------------------------------------------------------------------

## 1. Modelo mental

O Migration Harness **não é primariamente um conversor Angular →
React**. Ele é um harness independente de validação ao redor de uma
transformação.

``` text
Angular ──execute──► SourceTrace
   │
   ▼
Transformation ───► TransformationManifest
   │
   ▼
React ───execute──► TargetTrace

SourceTrace + TargetTrace + BehaviorContract + TransformationManifest
                              │
                              ▼
                    EquivalenceValidator
                       │           │
                  EQUIVALENT   NOT_EQUIVALENT
                                    │
                              classify + repair
```

A pergunta principal é:

> Há evidência independente suficiente de que a implementação target
> preserva o comportamento relevante da source dentro da MigrationUnit?

O **EquivalenceValidator é o centro da arquitetura**, não o LLM.

------------------------------------------------------------------------

## 2. Fundamentos pesquisados

### 2.1 Translation Validation

Base conceitual principal. Em vez de provar que o transformador sempre é
correto, valida-se cada transformação concreta produzida.

Aplicação:

``` text
Source → Codemod/LLM → Target → validação independente
```

Consequências:

-   código gerado é apenas um candidate;
-   sucesso do transformador não significa sucesso da migração;
-   o validator deve ser independente;
-   o transformador pode fornecer hints sobre o que mudou, mas esses
    hints não são prova.

Isso motivou o `TransformationManifest`.

**Referências** - George C. Necula, *Translation Validation for an
Optimizing Compiler*, PLDI 2000, DOI `10.1145/349299.349314` -
https://dblp.org/rec/conf/pldi/Necula00.html -
https://people.eecs.berkeley.edu/\~necula/papers.html

### 2.2 Regression Verification

Godlin e Strichman estudam equivalência entre versões sucessivas e
relacionadas de programas. Três ideias são particularmente úteis:

1.  não exigir uma especificação funcional completa;
2.  decompor equivalência em problemas menores;
3.  aproveitar mappings entre partes correspondentes.

Aplicação:

``` text
CustomerService.update
        ≈
useUpdateCustomer

CustomerFormComponent.save
        ≈
CustomerForm.handleSubmit
```

Isso reduz o papel do `BehaviorContract`: ele não precisa reconstruir
todo o legado.

**Referência** - Godlin & Strichman, *Regression verification: proving
the equivalence of similar programs*, DOI `10.1002/stvr.1472` -
https://onlinelibrary.wiley.com/doi/10.1002/stvr.1472

### 2.3 Characterization Testing

Characterization tests capturam o que o legado **faz atualmente**,
criando uma rede de segurança para mudanças.

Aplicação: `SourceTrace`.

Limitação fundamental:

> comportamento observado não é automaticamente comportamento correto ou
> obrigatório.

O legado pode conter bugs e acidentes históricos.

**Referência** - Michael Feathers, *Working Effectively with Legacy
Code* - https://www.infoq.com/news/2007/03/characterization-testing/

### 2.4 Specification Mining / Dynamic Invariant Detection

Daikon é a principal analogia pesquisada. Ele executa programas e infere
propriedades que parecem invariantes nos traces.

A palavra importante é **likely**.

Portanto:

``` text
campo "email" apareceu em 3/3 runs
```

pode gerar:

``` text
observedAlwaysFields = ["email"]
```

mas não automaticamente:

``` text
requiredFields = ["email"]
```

Promoção para requisito normativo exige fusão de evidências e/ou
aprovação.

**Referências** -
https://plse.cs.washington.edu/daikon/download/doc/daikon/Introduction.html -
https://plse.cs.washington.edu/daikon/pubs/invariants-tse2001-abstract.html

------------------------------------------------------------------------

## 3. Tese arquitetural

Nome técnico útil:

> **Evidence-Guided Translation Validation for Behavior-Preserving
> Software Migration**

O oráculo é composto, não monolítico:

``` text
              Equivalence Evidence
       ┌────────────┼──────────────┐
       ▼            ▼              ▼
 Differential    Critical      Transformation
  Execution      Contract          Hints
       └────────────┼──────────────┘
                    ▼
            EquivalenceResult
```

Nenhuma fonte pode silenciosamente redefinir correctness.

------------------------------------------------------------------------

## 4. Fluxo simplificado

O produto inteiro pode ser pensado em quatro verbos:

``` text
UNDERSTAND → TRANSFORM → COMPARE → REPAIR
```

**Understand:** definir boundary e coletar evidências source.\
**Transform:** usar codemods onde possível e LLM onde necessário.\
**Compare:** executar os mesmos cenários e comparar comportamento.\
**Repair:** localizar divergência, classificar e aplicar patch limitado
quando seguro.

------------------------------------------------------------------------

## 5. Objetos centrais

### MigrationUnit

Unidade coerente de migração; não necessariamente um arquivo/componente.

``` text
CustomerProfile
├── CustomerProfileComponent
├── CustomerFormComponent
├── CustomerService
├── CustomerDto
├── /customers/:id
└── PUT /api/customers/:id
```

Deve representar symbols, dependencies, routes, endpoints, boundary,
unresolved/dynamic edges e métricas de resolução.

### ScenarioDefinition

DSL tipada, serializável e determinística.

Ações iniciais:

``` text
click | fill | select | press | focus
```

Completion signals:

``` text
LOCATOR_VISIBLE
RESPONSE_RECEIVED
STORAGE_KEY_SET
```

Regra de race condition: o observer precisa ser armado **antes** da ação
que dispara o evento.

``` text
arm observer → execute action → await observer
```

Mocks e precondições de storage que afetam boot devem ser instalados
antes da navegação.

Não usar `networkidle` como definição genérica de conclusão; preferir
sinais explícitos.

### ObservedBehaviorTrace

Eventos iniciais:

``` text
USER_INTERACTION
HTTP_REQUEST
HTTP_RESPONSE
HTTP_FAILED
NAVIGATION
ARIA_STATE_CHANGE
STORAGE_DELTA
```

Trace é evidência de uma execução, não especificação.

Separar:

``` text
RawObservedTrace
SanitizedObservedTrace
```

### BehaviorContract

Na v0.2 contém apenas **invariantes críticos aprovados**, não todo
comportamento observado.

``` yaml
scenario: update-customer
critical_invariants:
  network:
    method: PUT
    path: /api/customers/:id
  validation:
    email:
      required: true
  success:
    navigation: /customers
  accessibility:
    error:
      role: alert
```

Fontes possíveis:

``` text
HUMAN_SPECIFICATION
OPENAPI
EXISTING_TESTS
STATIC_ANALYSIS
RUNTIME_OBSERVATION
```

Runtime isolado não deve promover automaticamente invariant BLOCKING.

### TransformationPlan

Define como conceitos source serão tratados.

``` text
@Input                  → React Props
Angular Service         → API module/hook/TanStack Query
Reactive Forms          → React Hook Form
simple TS               → codemod
Angular DI              → module/hook/state/factory conforme semântica
RxJS request-response   → potencialmente TanStack Query
RxJS event stream       → RxJS/XState/Zustand conforme semântica
```

Rejeitar mappings universais como `Angular DI → sempre Context` ou
`RxJS → sempre TanStack Query`.

### TransformationClass

``` text
STRUCTURE_PRESERVING
STRUCTURE_CHANGING
BEHAVIORAL_REIMPLEMENTATION
```

Estratégia:

``` text
STRUCTURE_PRESERVING
→ static/AST

STRUCTURE_CHANGING
→ static + contract + differential execution

BEHAVIORAL_REIMPLEMENTATION
→ differential execution forte + critical contract
```

### TransformationManifest

O transformador declara correspondências:

``` json
{
  "mappings": [{
    "source": "CustomerService.update",
    "target": "useUpdateCustomer",
    "preserves": ["HTTP_METHOD", "HTTP_PAYLOAD", "SUCCESS_BEHAVIOR"]
  }]
}
```

Serve para localização, decomposição, repair e auditabilidade.

**Nunca** aceitar um claim do manifest como prova.

### EquivalenceResult

Resultado estruturado:

``` text
NOT_EQUIVALENT
scenario: update-customer
dimension: NETWORK
code: NETWORK_METHOD_MISMATCH
source: PUT /api/customers/:id
target: POST /api/customers/:id
mapping: CustomerService.update → useUpdateCustomer
```

Deve ser consumível por humano, classifier, repair agent e audit log.

------------------------------------------------------------------------

## 6. Modelo de equivalência

Equivalente não significa byte-identical nem implementation-identical.

Significa equivalência suficiente sob dimensões/políticas declaradas.

### Network

Comparar normalizados:

-   method;
-   path template;
-   path params;
-   query params;
-   request structure;
-   status;
-   response structure relevante;
-   causal dependencies.

Não correlacionar requests somente por URL+method. Requests concorrentes
idênticos existem.

No recorder Playwright, usar identidade do objeto, por exemplo:

``` ts
WeakMap<Request, TraceMeta>
```

`requestfailed` é diferente de HTTP 4xx/5xx. Um 500 continua sendo uma
resposta HTTP concluída.

### Navigation

Capturar route transitions, redirects e destino final relevante.

### State

Inicialmente: deltas de localStorage/sessionStorage e outros estados
explicitamente observáveis.

### Accessibility

Priorizar semântica ARIA sobre pixel diff como sinal principal:

-   roles;
-   accessible names;
-   states;
-   tree structure.

Playwright atual possui `ariaSnapshot()` e `ariaSnapshotJSON()`.
`ariaSnapshotJSON({boxes:true})` inclui bounding boxes. A API JSON está
documentada a partir da v1.63; pin de versão deve refletir as APIs
usadas.

Referências: - https://playwright.dev/docs/next/api/class-locator -
https://playwright.dev/docs/next/api/class-page

Pixel/screenshot diff é evidência secundária.

------------------------------------------------------------------------

## 7. Causalidade

Não assumir strict request order.

``` text
A ──► B
└───► C
```

B e C podem terminar em ordens diferentes sem mudança semântica.

O modelo de longo prazo é:

``` text
causal DAG / partial order
```

e não uma sequência temporal total.

O MVP pode começar simples, mas o domínio não deve tornar strict
ordering a definição de equivalência.

------------------------------------------------------------------------

## 8. Normalização

Valores potencialmente voláteis:

-   timestamps;
-   generated IDs;
-   correlation IDs;
-   cache-busting params;
-   environment origins;
-   ordering de operações independentes.

Diferenças só devem ser ignoradas por regra explícita/auditável.

`/api/customers/123` também não é automaticamente um `pathTemplate`.
Hierarquia preferida para inferência:

``` text
OpenAPI
→ static API-client analysis
→ route/schema metadata
→ runtime heuristic
```

Separar `pathTemplate`, `pathParams` e `queryParams`.

------------------------------------------------------------------------

## 9. Evidence Fusion

Runtime miner gera candidates, não verdade normativa.

``` text
Runtime ───────────┐
Static analysis ───┤
OpenAPI ───────────┼──► candidate invariant → review
Existing tests ────┤
Human spec ────────┘
```

Exemplo forte:

``` text
runtime: email 3/3
OpenAPI: required
existing test: missing email rejected
```

é diferente de apenas `runtime: email 3/3`.

Presença deve ser calculada por **run distinto**, não por quantidade
bruta de requests.

Manter separados:

``` text
observedAlways
observedSometimes
required
optional
```

------------------------------------------------------------------------

## 10. Invariantes arquiteturais não negociáveis

### I. Contract Immutability

Transform e Repair Agents não podem alterar `BehaviorContract` aprovado.

Falha → corrigir target ou escalar. Nunca relaxar oracle
automaticamente.

### II. Zero Raw-Trace Leakage

`RawObservedTrace` nunca atravessa fronteira de LLM.

### III. Gate Override Precedence

Nenhum confidence score pode produzir `ELIGIBLE` se um blocking gate
falhou.

### IV. Transformation Evidence Is Not Truth

`TransformationManifest` ajuda, mas não determina equivalência.

### V. Source Observation Is Evidence, Not Specification

O observado não vira automaticamente requisito.

### VI. Validation Is Independent From Transformation

O gerador não decide sozinho se seu próprio output está correto.

------------------------------------------------------------------------

## 11. Integridade do contrato

Fluxo:

``` text
DRAFT → REVIEW → APPROVED → canonicalize → SHA-256
```

Conteúdo protegido deve incluir pelo menos:

``` text
unitId
contractId
version
scenarios
critical invariants
```

Canonicalização precisa ser recursiva.

Não usar como solução:

``` js
JSON.stringify(obj, Object.keys(obj).sort())
```

porque o replacer array afeta objetos aninhados e pode omitir campos.

`SHA-256` é integridade, não assinatura digital. Preferir:

``` text
approvedBy
approvedAt
integrity.sha256
```

e não `signedBy` sem assinatura real.

Hash não substitui isolamento de escrita. Transform/repair workers
futuramente não devem ter capability de escrita sobre contracts
aprovados.

------------------------------------------------------------------------

## 12. LLM Transform e LLM Repair

### Transform

Não é "converta este repo".

Entrada mínima:

``` text
MigrationUnit
+ relevant source
+ TransformationPlan
+ relevant critical invariants
+ target conventions
+ allowed dependencies
```

Saída:

``` text
target patch/code
+ TransformationManifest
```

Princípio:

> deterministic when possible; LLM when necessary.

### Repair

É separado do transform.

``` text
candidate → verify → FAIL → classify → bounded repair → verify
```

O repair recebe contexto localizado, por exemplo:

``` text
expected PUT
actual POST
source CustomerService.update
target useUpdateCustomer
file useUpdateCustomer.ts
```

e deve produzir minimal patch.

Repair volta para `EQUIVALENCE_VERIFY`, não para full transform.

------------------------------------------------------------------------

## 13. FailureDisposition

Taxonomia:

``` text
AUTO_REPAIRABLE
REQUIRES_CONTRACT_REVIEW
REQUIRES_SECURITY_REVIEW
REQUIRES_ARCHITECTURAL_REVIEW
NON_DETERMINISTIC
UNKNOWN
```

Só `AUTO_REPAIRABLE` entra automaticamente no repair loop.

------------------------------------------------------------------------

## 14. Segurança e prompt injection

Repository/runtime/external content é não confiável.

OWASP documenta indirect prompt injection em código, documentação,
issues, conteúdo remoto e outros inputs consumidos por coding agents.

Referências: -
https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html -
https://cheatsheetseries.owasp.org/cheatsheets/Secure_Coding_with_AI_Cheat_Sheet.html

Pipeline conceitual obrigatório:

``` text
RawObservedTrace
→ denylist
→ schema allowlist
→ PII scrubber
→ pseudonymization
→ SanitizedObservedTrace
→ LLM-safe projection
```

A implementação atual de regex scrubber é apenas uma camada inicial, não
a boundary completa.

Não capturar/enviar indiscriminadamente:

-   binary/huge bodies;
-   cookies;
-   Authorization;
-   tokens/secrets;
-   HTML arbitrário;
-   storage irrestrito;
-   PII desnecessária.

Adicionar content-type filtering, size caps, endpoint allowlists,
schema-aware projection e retention policy.

LLM workers: least privilege, restricted filesystem/network, package
allowlist, no production secrets, audit trail.

------------------------------------------------------------------------

## 15. Acessibilidade

Baseline: **WCAG 2.2 AA**.

WCAG prevê combinação de avaliação automatizada e humana. Logo:

``` text
axe passed ≠ WCAG compliant
ARIA parity ≠ WCAG compliant
```

Esses são sinais/evidências.

Referências: - https://www.w3.org/TR/WCAG22/ -
https://www.w3.org/WAI/WCAG22/Understanding/understanding-act-rules.html

------------------------------------------------------------------------

## 16. Playwright --- conhecimento operacional

Lifecycle documentado:

``` text
request
→ response
→ requestfinished
```

Falha de transporte:

``` text
requestfailed
```

HTTP 404/500 não é `requestfailed`.

`request.timing().responseEnd` fica disponível quando o request termina;
coletar timing final em `requestfinished`.

Referência: - https://playwright.dev/docs/api/class-request

Recorder deve:

1.  usar `WeakMap<Request, TraceMeta>`;
2.  rastrear e drenar handlers async antes de retornar trace;
3.  configurar network filtering, não hardcode `/api/`;
4.  capturar navigation;
5.  limitar body por content type/tamanho;
6.  evitar binary;
7.  resolver fixtures deterministicamente;
8.  tratar/filtrar HEAD e OPTIONS;
9.  tratar timing `-1`;
10. remover listeners em `finally`;
11. usar BrowserContext fresco por run quando necessário;
12. registrar `startedAt` no início real.

------------------------------------------------------------------------

## 17. Static analysis

Estrutura recomendada:

``` text
static-analyzer/
├── typescript/
├── angular-template/
├── rxjs/
├── routes/
└── graph/
```

TypeScript: compiler API/ts-morph para symbols/imports/dependencies.

Angular templates: usar parser Angular-aware
(`@angular/compiler`/conceitos equivalentes), não ts-morph sozinho.

RxJS: classificar semântica antes de mapear:

``` text
request-response
event stream
state stream
multi-event orchestration
cancellation-sensitive stream
```

Routes: conectar route config → component → MigrationUnit → scenarios.

Graph: preservar unresolved/dynamic edges explicitamente; não inventar
resolução.

------------------------------------------------------------------------

## 18. Quality gates

Severidade:

``` text
BLOCKING
WARNING
INFORMATIONAL
```

Blocking candidates:

-   contract integrity failure;
-   critical contract violation;
-   required scenario failure;
-   critical network divergence;
-   security-boundary violation.

Eligibility:

``` text
ELIGIBLE
ELIGIBLE_WITH_REVIEW
NOT_ELIGIBLE
```

Confidence score pode ser experimental/informacional, nunca override.

------------------------------------------------------------------------

## 19. FSM v0.2

``` text
DISCOVERY
 ↓
SCENARIO_PREPARATION
 ↓
SOURCE_TRACE_CAPTURE
 ↓
CONTRACT_SYNTHESIS
 ↓
CONTRACT_REVIEW
 ↓
CONTRACT_APPROVED
 ↓
TRANSFORMATION_PLAN
 ↓
TRANSFORM
 ↓
TARGET_TRACE_CAPTURE
 ↓
EQUIVALENCE_VERIFY
 ├─ EQUIVALENT → PR_READY
 └─ NOT_EQUIVALENT
       ↓
   FAILURE_CLASSIFIER
       ├─ review/escalation
       └─ AUTO_REPAIRABLE
              ↓
          REPAIR_PATCH
              └────► EQUIVALENCE_VERIFY
```

------------------------------------------------------------------------

## 20. Estado do scaffold v0.1

Já foi criado um monorepo com:

``` text
packages/
├── core/
├── static-analyzer/
├── trace-recorder/
├── contract-synthesizer/
├── contract-review/
├── codemods/
├── llm-worker/
├── quality-gates/
├── engine/
└── cli/
```

Implementado/prototipado:

-   core schemas;
-   typed scenario DSL;
-   TemporalTraceRecorder;
-   request correlation por `WeakMap`;
-   request/response/requestfailed;
-   storage preconditions antes de goto;
-   mock routes antes de goto;
-   storage deltas;
-   ARIA snapshots;
-   completion signals;
-   initial scrubber;
-   multi-run invariant miner;
-   recursive contract canonicalization/hash;
-   FSM com bounded repair;
-   extension ports para static analysis, codemods, LLM e quality gates.

RFC v0.2 adiciona/eleva conceitualmente:

``` text
scenario-runner/
trace-sanitizer/
transformation-planner/
equivalence-validator/
TransformationManifest
EquivalenceResult
```

Refatorar incrementalmente; não reescrever código funcional apenas por
topologia.

------------------------------------------------------------------------

## 21. Dívida conhecida do prototype

Antes de chamar o recorder de production-ready:

1.  corrigir `startedAt`;
2.  await/drain de processamento async de `requestfinished`;
3.  network filter configurável;
4.  navigation events;
5.  response content-type/size caps;
6.  binary handling;
7.  fixture path determinístico;
8.  HEAD/OPTIONS;
9.  timing unavailable values;
10. runtime schema validation;
11. separar `ScenarioRunner` do recorder;
12. raw/sanitized em domínios separados;
13. projection schema-aware;
14. scrubber/security tests;
15. contract integrity tests;
16. FSM tests;
17. path-template inference;
18. EvidenceFusionEngine;
19. write isolation para approved contracts;
20. pin de Playwright compatível com APIs usadas.

------------------------------------------------------------------------

## 22. Runtime validation

Interfaces TypeScript não validam JSON em runtime.

Adicionar validação para:

``` text
ScenarioDefinition
RawObservedTrace
SanitizedObservedTrace
BehaviorContract
TransformationManifest
EquivalenceResult
CLI/config
```

Zod é uma opção adequada para o MVP, sem acoplar a arquitetura a ele.

------------------------------------------------------------------------

## 23. Artifact security layout

Sugestão:

``` text
.migration-private/
└── raw/
    └── units/<unitId>/scenarios/<scenarioId>/*.trace.json

artifacts/
└── units/<unitId>/scenarios/<scenarioId>/
    ├── source/*.sanitized.json
    ├── target/*.sanitized.json
    └── equivalence/
```

`.migration-private/` deve ser gitignored por padrão e ter
retention/access policy.

------------------------------------------------------------------------

## 24. Ordem correta de implementação

### Phase 1 --- Differential Equivalence

Usar Angular real + React manual. **Sem LLM inicialmente.**

Implementar:

1.  runtime schemas;
2.  ScenarioRunner;
3.  recorder robusto;
4.  sanitizer;
5.  source/target execution;
6.  normalization;
7.  `equivalence-validator/network`;
8.  structured `EquivalenceResult`.

Primeiro experimento obrigatório:

``` text
Angular PUT /api/customers/:id
React PUT /api/customers/:id
→ EQUIVALENT

alterar React propositalmente:
PUT → POST
→ NOT_EQUIVALENT / NETWORK_METHOD_MISMATCH

restaurar PUT
→ EQUIVALENT
```

### Phase 2 --- Critical Contracts

Evidence candidates → synthesis → human approval → recursive hash →
contract gate → protected artifact.

### Phase 3 --- Discovery

TS + Angular template + routes + API/service usage + RxJS
classification + dependency graph.

### Phase 4 --- Automated Transformation

TransformationPlan → codemods → bounded LLM transform →
TransformationManifest → existing validator.

### Phase 5 --- Bounded Repair

FailureClassifier → localized context → minimal patch → sandbox → retry
budget → revalidation → audit.

------------------------------------------------------------------------

## 25. MVP Definition of Done

O piloto só passa se:

``` text
1. selecionar MigrationUnit Angular real
2. executar source scenario
3. capturar source trace
4. sanitizar
5. aprovar critical invariants
6. transformar para React
7. gerar TransformationManifest
8. executar mesmo scenario no React
9. comparar
10. detectar regressão intencional
11. localizar divergência
12. classificar
13. aplicar bounded repair
14. reexecutar
15. obter EQUIVALENT
16. provar que BehaviorContract não mudou
17. gerar audit trail
```

Gerar React compilável, sozinho, não é sucesso.

------------------------------------------------------------------------

## 26. Test matrix inicial

  ---------------------------------------------------------------------------------
  Caso              Source                 Target                 Esperado
  ----------------- ---------------------- ---------------------- -----------------
  Mesmo método/path PUT                    PUT                    pass
                    `/api/customers/123`   `/api/customers/123`   

  Method regression PUT                    POST                   fail

  Status regression 204                    200                    fail se status
                                                                  relevante

  Volatile query    `?ts=1`                `?ts=2`                pass se `ts`
                                                                  declarado volátil

  Required query    `mode=full`            `mode=summary`         fail

  HTTP 500 em ambos 500                    500                    potencialmente
                                                                  equivalent

  Transport failure response               requestfailed          fail
  só target                                                       

  B/C independentes B,C                    C,B                    pass se
  reordenados                                                     causalmente
                                                                  independentes
  ---------------------------------------------------------------------------------

Transformar isso em testes executáveis.

------------------------------------------------------------------------

## 27. Regras para qualquer agente que continue o projeto

1.  **Validation independence:** transformador não valida o próprio
    resultado.
2.  **Observed is not normative:** runtime repetition não vira blocking
    rule automaticamente.
3.  **Minimize LLM authority:** determinístico quando confiável.
4.  **Minimize LLM context:** contexto mínimo necessário.
5.  **Never repair the oracle:** repair target ou escalate.
6.  **Preserve provenance:** conclusões importantes apontam para
    evidência.
7.  **Expose uncertainty:** unresolved/ambiguous permanece explícito.
8.  **Semantics before pixels:** network/state/navigation/ARIA antes de
    screenshot.
9.  **Avoid false guarantees:** falar em
    evidence/observed/equivalent-under-policy, não "prova formal" quando
    não existe.
10. **Vertical slice first:** um fluxo real end-to-end antes de
    generalizar.

------------------------------------------------------------------------

## 28. Próxima tarefa recomendada

Não começar por `LLM Transform`.

Construir primeiro o menor loop confiável Angular ↔ React:

``` text
A. runtime schemas
B. ScenarioRunner
C. harden TraceRecorder
D. trace normalizer
E. equivalence-validator/network
F. method/path/status/payload-structure comparison
G. structured EquivalenceResult
H. minimal Angular/React fixture ou tela real
I. PUT→POST regression test
J. restore→pass test
```

Depois adicionar, nesta ordem:

``` text
navigation
storage
ARIA
causal relationships
critical contract gates
```

------------------------------------------------------------------------

## 29. Fontes principais

### Translation Validation

George C. Necula --- *Translation Validation for an Optimizing
Compiler*\
DOI `10.1145/349299.349314`\
https://dblp.org/rec/conf/pldi/Necula00.html

### Regression Verification

Benny Godlin, Ofer Strichman --- *Regression verification: proving the
equivalence of similar programs*\
DOI `10.1002/stvr.1472`\
https://onlinelibrary.wiley.com/doi/10.1002/stvr.1472

### Dynamic invariant detection / Daikon

https://plse.cs.washington.edu/daikon/download/doc/daikon/Introduction.html\
https://plse.cs.washington.edu/daikon/pubs/invariants-tse2001-abstract.html

### Characterization Testing

Michael Feathers --- *Working Effectively with Legacy Code*\
https://www.infoq.com/news/2007/03/characterization-testing/

### Playwright

https://playwright.dev/docs/api/class-request\
https://playwright.dev/docs/next/api/class-locator\
https://playwright.dev/docs/next/api/class-page

### Accessibility

https://www.w3.org/TR/WCAG22/\
https://www.w3.org/WAI/WCAG22/Understanding/understanding-act-rules.html

### LLM Security

https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html\
https://cheatsheetseries.owasp.org/cheatsheets/Secure_Coding_with_AI_Cheat_Sheet.html

------------------------------------------------------------------------

## 30. Resumo que não pode se perder

``` text
The Migration Harness is not primarily an Angular→React generator.

It is an independent validation harness around a transformation.

Source behavior is observed, but observation is not automatically truth.
Critical invariants are reviewed and protected.
Codemods handle deterministic transformations.
LLMs handle bounded semantic transformations.
TransformationManifest provides hints, never proof.
Source and target execute the same deterministic scenarios.
EquivalenceValidator compares observable behavior independently.
Blocking gates cannot be overridden by confidence scores.
Failures are classified before repair.
Repair changes target code, never the approved oracle.
Raw runtime evidence never goes to the LLM.

The first engineering milestone is NOT automatic migration.
It is reliably detecting an intentional behavioral regression
between Angular and React.
```
