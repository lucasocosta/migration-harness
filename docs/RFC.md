# RFC — Migration Harness v0.2

**Status:** Draft  
**Objetivo inicial:** Angular → React  
**Arquitetura:** Framework-agnostic  
**Abordagem:** Evidence-Guided Translation Validation

---

## 1. Resumo

O Migration Harness é uma plataforma para migração assistida de software cujo objetivo principal não é traduzir código, mas **preservar comportamento durante uma transformação**.

Para uma migração Angular → React, o sistema deve responder:

> A implementação React preserva suficientemente o comportamento relevante da implementação Angular?

O Harness utiliza três fontes principais de evidência:

1. **Differential Execution** — comparação do comportamento observado no sistema original e no sistema migrado.
2. **BehaviorContract** — invariantes críticos que explicitamente não podem mudar.
3. **TransformationManifest** — correspondência entre elementos da implementação original e da implementação transformada.

A transformação pode utilizar codemods, AST transformations e LLMs, mas nenhuma transformação é considerada correta apenas porque foi gerada com sucesso.

Cada resultado deve passar por validação de equivalência.

---

## 2. Princípio fundamental

A arquitetura segue o princípio de **Translation Validation**:

> Não precisamos provar que o migrador sempre gera código correto. Precisamos validar cada transformação concreta produzida por ele.

Portanto:

```text
Source
  │
  ▼
Transformation
  │
  ▼
Target
  │
  ▼
Equivalence Validation
  │
  ├── equivalent → accept
  │
  └── divergent → reject / repair
```

No primeiro adapter:

```text
Angular
  │
  ▼
Codemod / LLM
  │
  ▼
React
  │
  ▼
Equivalence Validator
```

O LLM é um mecanismo de transformação, não uma fonte de verdade.

---

## 3. Objetivos

O Migration Harness deve:

- identificar uma unidade coerente de migração;
- entender estruturalmente o código legado;
- executar cenários reproduzíveis;
- observar comportamento relevante;
- preservar invariantes críticos;
- transformar código de forma determinística quando possível;
- utilizar LLM somente quando a transformação exigir interpretação semântica;
- registrar a correspondência entre source e target;
- comparar comportamento source ↔ target;
- localizar divergências;
- realizar reparos limitados quando seguro;
- produzir evidências auditáveis da migração.

---

## 4. Não objetivos

O MVP não pretende:

- provar equivalência matemática completa entre aplicações;
- inferir automaticamente toda regra de negócio;
- substituir revisão humana;
- garantir conformidade WCAG apenas através de ferramentas automatizadas;
- migrar um repositório inteiro em uma única operação;
- permitir que agentes alterem critérios de validação para fazer uma migração passar;
- permitir execução irrestrita de código gerado por LLM.

O objetivo é obter **evidência suficiente e explícita de preservação de comportamento dentro do escopo definido da MigrationUnit**.

---

## 5. Conceitos fundamentais

### 5.1 MigrationUnit

`MigrationUnit` é a unidade mínima coerente de migração.

Ela pode conter múltiplos arquivos e componentes.

Exemplo:

```text
CustomerProfile
├── CustomerProfileComponent
├── CustomerFormComponent
├── CustomerService
├── CustomerDto
├── /customers/:id
└── PUT /api/customers/:id
```

A unidade é determinada por análise estrutural e dependências, não simplesmente por arquivos individuais.

Ela define o boundary da validação.

---

### 5.2 ScenarioDefinition

Um cenário descreve uma interação reproduzível com a funcionalidade.

Exemplo:

```text
Given:
customer 123 exists

When:
open /customers/123
change email
click "Salvar"

Then:
wait for PUT /api/customers/123
```

Cenários devem utilizar uma DSL tipada e serializável.

Ações suportadas inicialmente:

```text
click
fill
select
press
focus
```

Completion signals suportados:

```text
LOCATOR_VISIBLE
RESPONSE_RECEIVED
STORAGE_KEY_SET
```

O executor deve instalar mocks, storage e demais precondições **antes da inicialização da aplicação**.

---

## 6. Observed Behavior

Ao executar um cenário, o Harness registra comportamento observável.

Exemplos:

```text
USER_INTERACTION
HTTP_REQUEST
HTTP_RESPONSE
HTTP_FAILED
NAVIGATION
ARIA_STATE_CHANGE
STORAGE_DELTA
```

Esses eventos formam:

```text
ObservedBehaviorTrace
```

Um trace representa **evidência de uma execução**, não uma especificação.

Portanto:

> Observado ≠ obrigatório.

Se um campo apareceu em todas as execuções observadas, isso não significa automaticamente que ele é uma regra obrigatória do sistema.

---

## 7. Segurança dos traces

Dados capturados da aplicação devem ser tratados como:

> dados não confiáveis.

Isso inclui conteúdo potencialmente utilizado em indirect prompt injection.

O fluxo obrigatório é:

```text
RawObservedTrace
       │
       ▼
denylist
       │
       ▼
schema allowlist
       │
       ▼
PII scrubber
       │
       ▼
pseudonymization
       │
       ▼
SanitizedObservedTrace
       │
       ▼
LLM-safe projection
```

### Regra

O harness nunca envia `RawObservedTrace` no canal harness -> assistente. No modo
assistant-driven, leituras diretas pelo mesmo usuário são um risco residual
controlado por política e tooling, não uma garantia de isolamento (§25 e §33.II).

Nenhum prompt deve receber:

- HAR bruto;
- cookies;
- Authorization headers;
- tokens;
- secrets;
- dados pessoais não necessários;
- payload arbitrário da aplicação.

---

## 8. BehaviorContract

O `BehaviorContract` deixa de representar todo o comportamento observado.

Ele contém somente **invariantes críticos explicitamente aprovados**.

Exemplo:

```yaml
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

Possíveis fontes:

```text
HUMAN_SPECIFICATION
OPENAPI
EXISTING_TESTS
STATIC_ANALYSIS
RUNTIME_OBSERVATION
```

Runtime observation isoladamente não deve promover automaticamente uma observação para um invariant `BLOCKING`.

---

## 9. Aprovação do contrato

Um contrato passa por:

```text
DRAFT
  ↓
REVIEW
  ↓
APPROVED
```

Ao ser aprovado:

```text
canonical contract
       ↓
SHA-256
       ↓
integrity hash
```

O conteúdo protegido inclui pelo menos:

```text
unitId
contractId
version
scenarios
critical invariants
```

A canonicalização deve ser recursiva.

`approvedBy` registra a aprovação humana.

Hash SHA-256 representa integridade, não assinatura digital.

---

## 10. Contract Immutability

Após aprovação:

> Nenhum agente de transformação ou repair pode modificar o BehaviorContract.

Se:

```text
React
  ↓
validation
  ↓
FAIL
```

o agente pode:

```text
corrigir React
```

mas nunca:

```text
alterar contrato
para fazer o React passar
```

Mudanças no contrato exigem novo processo explícito de revisão.

---

## 11. TransformationPlan

Antes da transformação, o Harness cria um plano.

Exemplo:

```text
Angular                     React

@Input                  →   Props

Angular Service         →   API module /
                            TanStack Query

Reactive Forms          →   React Hook Form

Angular DI              →   module / hook /
                            state / factory

RxJS request-response   →   TanStack Query

RxJS event stream       →   RxJS / XState /
                            Zustand
```

Nenhum mapping arquitetural deve ser universal.

Exemplo:

```text
Angular DI ≠ sempre React Context
RxJS       ≠ sempre TanStack Query
```

O plano deve considerar a semântica encontrada.

---

## 12. Classes de transformação

Cada transformação é classificada como:

```text
STRUCTURE_PRESERVING
STRUCTURE_CHANGING
BEHAVIORAL_REIMPLEMENTATION
```

### STRUCTURE_PRESERVING

Exemplo:

```text
TypeScript interface
        ↓
TypeScript interface
```

Preferência:

```text
codemod / AST
```

Validação:

```text
static validation
```

### STRUCTURE_CHANGING

Exemplo:

```text
Angular Reactive Forms
        ↓
React Hook Form
```

Pode utilizar:

```text
codemod + LLM
```

Validação:

```text
static
+
contract
+
differential execution
```

### BEHAVIORAL_REIMPLEMENTATION

Exemplo:

```text
Angular orchestration
        ↓
React hooks + state machine
```

Validação forte:

```text
BehaviorContract
+
Differential Execution
```

---

## 13. Transformação

O princípio é:

> Determinístico quando possível; LLM quando necessário.

Pipeline:

```text
MigrationUnit
      │
      ▼
TransformationPlan
      │
      ├── deterministic
      │       ↓
      │    Codemods
      │
      └── semantic
              ↓
         LLM Transform
              │
              ▼
        React Candidate
```

O LLM deve receber apenas contexto necessário.

Nunca o repositório inteiro por padrão.

---

## 14. TransformationManifest

Toda transformação deve produzir evidência de correspondência entre source e target.

Exemplo:

```json
{
  "mappings": [
    {
      "source": "CustomerService.update",
      "target": "useUpdateCustomer",
      "preserves": [
        "HTTP_METHOD",
        "HTTP_PAYLOAD",
        "SUCCESS_BEHAVIOR"
      ]
    },
    {
      "source": "CustomerFormComponent.save",
      "target": "CustomerForm.handleSubmit",
      "preserves": [
        "VALIDATION",
        "SUBMISSION_FLOW"
      ]
    }
  ]
}
```

O manifest não prova equivalência.

Ele fornece **hints verificáveis** ao validator.

Portanto:

> TransformationManifest é evidência, não autoridade.

---

## 15. Differential Execution

O mesmo `ScenarioDefinition` deve ser executado contra:

```text
Source
```

e:

```text
Target
```

No primeiro adapter:

```text
Angular
React
```

Produzindo:

```text
SourceTrace
TargetTrace
```

Os traces são então normalizados antes da comparação.

Exemplo:

```text
Angular:
PUT /api/customers/123?timestamp=123456

React:
PUT /api/customers/123?timestamp=987654
```

Campos explicitamente classificados como voláteis não devem causar divergência.

---

## 16. Causal comparison

Requests não devem ser comparados simplesmente por ordem temporal.

Exemplo:

```text
A ──► B
│
└──► C
```

B e C podem terminar em ordens diferentes sem alterar o comportamento.

O Harness deve representar dependências relevantes como relações causais.

Portanto:

```text
strict sequence
```

não é o modelo padrão.

Preferência:

```text
causal ordering / partial order
```

---

## 17. EquivalenceValidator

Esta é a peça central da arquitetura.

Entrada:

```text
SourceTrace
TargetTrace
BehaviorContract
TransformationManifest
MigrationUnit
```

Processamento:

```text
             Equivalence Validator

          ┌──────────┼───────────┐
          │          │           │
          ▼          ▼           ▼

      Contract    Differential  Transformation
      Invariants    Behavior       Hints

          │          │           │
          └──────────┼───────────┘
                     ▼

             EquivalenceResult
```

---

## 18. Dimensões de equivalência

O MVP verifica:

### Network

```text
HTTP method
path template
path parameters
query parameters
request structure
response status
causal dependencies
```

### Navigation

```text
route transitions
redirects relevantes
```

### State

```text
localStorage
sessionStorage
observable state transitions
```

### Accessibility / semantics

```text
ARIA tree
roles
names
states
interactive controls
```

### Critical Contract

```text
explicit approved invariants
```

Visual pixel comparison pode existir como evidência secundária, mas não é o oráculo principal.

---

## 19. EquivalenceResult

Resultado:

```text
EQUIVALENT
```

ou:

```text
NOT_EQUIVALENT
```

com divergências estruturadas.

Exemplo:

```text
NOT_EQUIVALENT

scenario:
update-customer

dimension:
NETWORK

source:
PUT /api/customers/:id

target:
POST /api/customers/:id

mapping:
CustomerService.update
→
useUpdateCustomer
```

Isso permite localizar a falha antes do repair.

---

## 20. Quality Gates

Nem toda evidência tem a mesma importância.

Existem:

```text
BLOCKING
WARNING
INFORMATIONAL
```

Exemplos BLOCKING:

```text
BehaviorContract violation
contract integrity failure
critical network divergence
required scenario failure
security boundary violation
```

Exemplos WARNING:

```text
ARIA difference não crítica
visual difference
missing known error scenario
```

---

## 21. Release Eligibility

Resultado final:

```text
ELIGIBLE
ELIGIBLE_WITH_REVIEW
NOT_ELIGIBLE
```

Regra fundamental:

> Nenhum Confidence Score pode tornar uma migração ELIGIBLE quando um blocking gate falhou.

Confidence Score pode existir como informação experimental.

Nunca como override.

---

## 22. Failure Classification

Uma divergência é classificada antes de qualquer repair.

```text
AUTO_REPAIRABLE

REQUIRES_CONTRACT_REVIEW

REQUIRES_SECURITY_REVIEW

REQUIRES_ARCHITECTURAL_REVIEW

NON_DETERMINISTIC

UNKNOWN
```

Somente:

```text
AUTO_REPAIRABLE
```

pode entrar automaticamente no repair loop.

---

## 23. Bounded Repair

O repair recebe contexto mínimo.

Exemplo:

```text
Divergence:

expected:
PUT /api/customers/:id

actual:
POST /api/customers/:id

source:
CustomerService.update

target:
useUpdateCustomer

affected files:
useUpdateCustomer.ts
```

O agente produz:

```text
minimal patch
```

e não uma nova transformação completa.

Fluxo:

```text
FAIL
 ↓
Failure Classifier
 ↓
AUTO_REPAIRABLE
 ↓
Repair Patch
 ↓
Equivalence Validator
 ↓
PASS / FAIL
```

Existe limite máximo de tentativas.

---

## 24. FSM

A máquina de estados passa a ser:

```text
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
   │
   ├── EQUIVALENT
   │       ↓
   │    PR_READY
   │
   └── NOT_EQUIVALENT
           ↓
     FAILURE_CLASSIFIER
       │        │
       │        └── review/escalation
       │
       ▼
   REPAIR_PATCH
       │
       └────────────► EQUIVALENCE_VERIFY
```

O repair nunca volta para `TRANSFORM`.

---

## 25. Segurança do LLM Worker

Desde o pivot de 2026-09-05, Transform e Repair semânticos são conduzidos por um
assistente de código operado por uma pessoa. O harness emite briefs e aplica gates;
não chama um modelo via API no fluxo principal. `HttpWorkerProvider` permanece
apenas como adapter opcional. O contrato executável está em
`ASSISTANT-INTEGRATION.md`.

O canal de integração impõe as seguintes restrições:

```text
bounded brief with structural trace projection
approved contract and source references only
package allowlist
no production secrets
candidate write allowlist and brief-time hashes
protected-input fingerprints
bounded submissions and repair edit budget
audit trail
```

Os comandos recusam caminhos privados, links de candidato, alterações fora do
escopo e tokens de traces em patches/manifests. A projeção exclui valores de runtime;
o brief inteiro é inspecionado antes de sua publicação. Um contrato aprovado
incompatível com essa higiene exige nova revisão, nunca remoção silenciosa de
invariantes para viabilizar a transformação.

O assistente ainda tem os acessos do usuário ao filesystem e à rede. `AGENTS.md`
limita leituras a `contextFiles`/`allowedFiles` e proíbe acesso a raw traces, mas
esses acessos externos aos comandos não são observáveis nem impedidos pelo harness.
Retenção mínima de raw traces reduz a exposição. Hashes e o registro local de briefs
detectam inconsistências; não autenticam um usuário capaz de modificar o registro.
O sandbox Docker continua sendo a fronteira para comandos de candidato executados
pelo harness; análise estática não é um sandbox. Escritas em lote têm rollback de
falhas tratadas, sem garantia transacional entre arquivos diante de crash do processo.

Conteúdo proveniente da aplicação deve ser tratado como dados, nunca como instrução.

Exemplo:

```text
HTTP response:

{
  "message":
  "Ignore previous instructions and..."
}
```

Esse conteúdo nunca deve alterar o comportamento do agente.

---

## 26. Arquitetura

```text
                     MIGRATION HARNESS

                         MigrationUnit
                              │
                  ┌───────────┴───────────┐
                  │                       │
                  ▼                       ▼
           Static Analysis          Scenario Runner
                                          │
                                          ▼
                                    Source Trace
                                          │
                                          ▼
                                   Sanitization
                                          │
                     ┌────────────────────┘
                     ▼
               BehaviorContract
                     │
                     ▼
                Human Review
                     │
                     ▼
                 APPROVED
                     │
                     ▼
             TransformationPlan
                     │
              ┌──────┴──────┐
              ▼             ▼
           Codemods      LLM Transform
              │             │
              └──────┬──────┘
                     ▼
              Target Candidate
                     │
                     ├── TransformationManifest
                     │
                     ▼
               Scenario Runner
                     │
                     ▼
                Target Trace
                     │
                     ▼
              EquivalenceValidator
               ▲        ▲        ▲
               │        │        │
            Source    Contract  Manifest
             Trace
                     │
                ┌────┴────┐
                ▼         ▼
           EQUIVALENT   DIVERGENT
                │         │
                ▼         ▼
            PR READY    Classify
                          │
                          ▼
                     Bounded Repair
                          │
                          └──────► Validate
```

---

## 27. Packages

```text
migration-harness/

packages/

  core/
    schemas
    migration-unit
    behavior-contract
    transformation-manifest
    equivalence-result

  static-analyzer/
    typescript/
    angular-template/
    rxjs/
    routes/
    graph/

  scenario-runner/

  trace-recorder/

  trace-sanitizer/

  contract-synthesizer/

  contract-review/

  transformation-planner/

  codemods/

  llm-worker/
    transform/
    repair/

  equivalence-validator/
    network/
    navigation/
    state/
    aria/
    causal/

  quality-gates/

  engine/

  cli/
```

---

## 28. MVP

O MVP não começa pela migração automática.

Primeiro devemos provar que conseguimos determinar divergência entre duas implementações.

### MVP 1 — Equivalence Engine

Dado:

```text
Angular implementation
React implementation manual
ScenarioDefinition
```

o Harness deve:

```text
execute Angular
      ↓
capture SourceTrace

execute React
      ↓
capture TargetTrace

normalize
      ↓
compare
      ↓
EquivalenceResult
```

### Critério de sucesso

Introduzir propositalmente uma regressão no React:

```text
PUT → POST
```

O Harness deve retornar:

```text
NOT_EQUIVALENT

NETWORK_METHOD_MISMATCH
expected PUT
actual POST
```

Corrigir a regressão deve produzir:

```text
EQUIVALENT
```

---

## 29. MVP 2 — Critical Contracts

Adicionar:

```text
BehaviorContract
```

com invariantes explicitamente aprovados.

O Harness deve detectar uma violação mesmo quando ela não puder ser inferida apenas por comparação diferencial.

---

## 30. MVP 3 — Automated Transformation

Adicionar:

```text
TransformationPlan
      ↓
Codemods
      +
LLM Transform
      ↓
React Candidate
      +
TransformationManifest
```

O candidate passa pelo mesmo `EquivalenceValidator`.

---

## 31. MVP 4 — Automated Repair

Adicionar:

```text
NOT_EQUIVALENT
      ↓
FailureClassifier
      ↓
AUTO_REPAIRABLE
      ↓
LLM Repair
      ↓
minimal patch
      ↓
EquivalenceValidator
```

O agente não pode modificar:

```text
BehaviorContract
SourceTrace
validation rules
blocking gates
```

---

## 32. Definition of Done

O primeiro piloto completo deve demonstrar:

```text
1. selecionar MigrationUnit Angular

2. executar cenário no Angular

3. capturar comportamento source

4. sanitizar evidências

5. aprovar invariantes críticos

6. transformar Angular → React

7. produzir TransformationManifest

8. executar o mesmo cenário no React

9. comparar source ↔ target

10. detectar uma regressão proposital

11. classificar a divergência

12. produzir repair limitado

13. executar novamente

14. obter EQUIVALENT

15. provar que o BehaviorContract
    permaneceu inalterado

16. gerar audit trail
```

O piloto só é considerado bem-sucedido se uma regressão intencional for detectada e corrigida sem alteração do oráculo aprovado.

---

## 33. Invariantes arquiteturais

### I. Contract Immutability

Transformation e Repair Agents não podem modificar contratos aprovados.

### II. Zero Raw-Trace Leakage

RawObservedTrace nunca atravessa o canal harness -> assistente por construção.
O acesso direto e irrestrito do assistente aos arquivos do mesmo usuário é um risco
residual controlado por política: briefs como entrada exclusiva, retenção mínima
de raw traces e inspeção de vazamentos nas submissões. Essas medidas não garantem
que leituras fora do canal sejam impedidas ou detectadas.

### III. Gate Override Precedence

Blocking gate sempre prevalece sobre scores ou heurísticas.

### IV. Transformation Evidence Is Not Truth

TransformationManifest auxilia validação, mas não determina equivalência.

### V. Source Observation Is Evidence, Not Specification

Comportamento observado não é automaticamente uma regra obrigatória.

### VI. Validation Is Independent From Transformation

O mecanismo responsável por gerar código não pode decidir sozinho se sua própria transformação está correta.

---

## 34. Direção arquitetural

A arquitetura do produto pode ser resumida em:

```text
UNDERSTAND
    ↓
TRANSFORM
    ↓
COMPARE
    ↓
REPAIR
```

Ou, formalmente:

```text
Source Program
      +
Critical Invariants
      ↓
Transformation
      ↓
Target Program
      ↓
Translation Validation
      ↓
Behavioral Equivalence Evidence
```

Angular → React é apenas o primeiro adapter.

O núcleo do Migration Harness deve permanecer independente do framework de origem e destino.

---

## 35. Decisão

O Migration Harness será desenvolvido como um sistema de **Evidence-Guided Translation Validation para Behavior-Preserving Software Migration**.

O `EquivalenceValidator`, e não o LLM, é o centro da arquitetura.

O LLM é substituível.

O transformador é substituível.

Angular e React são substituíveis.

O mecanismo de evidência e validação de equivalência constitui o núcleo do produto.
