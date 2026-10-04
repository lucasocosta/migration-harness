# Pesquisa - fundamentos e limites

Reconciliada em 2026-09-06 com a [RFC v0.3](../RFC.md).
Este arquivo preserva a pesquisa util, nao um roteiro de implementacao.
Foram removidos estados do scaffold, listas antigas de proximas tarefas, FSM e
protocolos duplicados da v0.2. O historico anterior permanece no Git.
Plano vigente: [PLAN.md](../PLAN.md); capacidades reais: [STATUS.md](../STATUS.md).
Paisagem competitiva e padroes emprestaveis: [COMPETITIVE.md](./COMPETITIVE.md).

## 1. Modelo mental mantido

O harness nao e primariamente um conversor Angular -> React.
Ele executa origem e destino e verifica cada transformacao concreta:

```text
Source -> execucao -> evidencia
   |
   +-> transformacao pelo assistente -> Target -> execucao -> evidencia
                                                           |
                                 comparacao independente <--+
```

Pergunta: ha evidencia suficiente de preservacao do comportamento relevante
dentro do escopo? O resultado vale para cenarios/politicas executados; nao e
uma prova formal de equivalencia de programas arbitrarios.

## 2. Translation validation

Validar cada traducao concreta, em vez de confiar que o transformador sempre
esta correto. Geracao de codigo compilavel nao aprova uma migracao.
Hints/mappings do transformador podem ajudar na localizacao, mas nao sao prova.

Aplicacao ao produto: o mesmo agente pode programar e chamar o comparador.
A independencia esta no mecanismo de avaliacao e nos criterios protegidos,
nao na exigencia de outro modelo ou de uma conversa limpa.

Referencia: George C. Necula, Translation Validation for an Optimizing Compiler,
PLDI 2000, [DOI 10.1145/349299.349314](https://doi.org/10.1145/349299.349314).
A aplicacao a traces de UI e uma adaptacao de engenharia, nao a mesma garantia
formal de uma infraestrutura de validacao de compiladores.

## 3. Regression verification

Ideias uteis: nao reconstruir uma especificacao completa do legado; decompor
o problema por funcionalidades e usar correspondencias entre origem/destino.
Isso favorece paginas/componentes e depois regressao integrada.

Referencia: Godlin e Strichman, Regression verification: proving the equivalence
of similar programs, [DOI 10.1002/stvr.1472](https://doi.org/10.1002/stvr.1472).
Nao inferir que uma bateria finita de testes prova equivalencia universal.

## 4. Characterization testing

Caracterizar o que o legado faz fornece uma rede de seguranca para a mudanca.
O observado pode conter bugs: preservar comportamento e atender requisitos sao
perguntas diferentes. Diferencas intencionais precisam ser explicitas.

Referencia original da pesquisa: Michael Feathers, Working Effectively with
Legacy Code; [registro da discussao](https://www.infoq.com/news/2007/03/characterization-testing/).
No fluxo padrao, referencia observacional nao exige transformar cada observacao
em um contrato formalmente aprovado.

## 5. Specification mining

Daikon infere invariantes provaveis a partir de execucoes. Um campo aparecer em
tres runs nao prova que seja obrigatorio em todos os casos.
Separar observado sempre/as vezes de obrigatorio/opcional.

Fontes:
- [Introducao ao Daikon](https://plse.cs.washington.edu/daikon/download/doc/daikon/Introduction.html).
- [Artigo de invariantes dinamicos](https://plse.cs.washington.edu/daikon/pubs/invariants-tse2001-abstract.html).

Mineracao, OpenAPI e testes existentes podem sugerir/corroborar criterios.
Nao sao precondicoes de toda comparacao nem autorizam autoaprovacao humana.
Preservar procedencia e incerteza, especialmente para contratos criticos opcionais.

## 6. Execucao diferencial e equivalencia

Usar cenarios semanticamente correspondentes, dados/reset reproduziveis e
observacoes de rede, navegacao, estado e semantica acessivel.
Rotas e locators podem ter bindings diferentes para integrar um React existente.

A pesquisa inicial priorizou metodo/path/status e estrutura de payload como
primeiro experimento. Isso e insuficiente para dizer que o valor editado foi salvo.
A v0.3 acrescenta valores selecionados, resultados e assertivas por funcionalidade.

Normalizar somente volatilidade declarada: timestamps, IDs gerados, query e origem.
Nao apagar diferencas significativas sob a justificativa de frameworks diferentes.
Comparar operacoes independentes sem ordem temporal estrita; requisitos causais
permanecem declarados. Navegacao principal nao vira um multiconjunto de URLs.
Instrumentacao causal automatica de toda a aplicacao continua fora do escopo.

## 7. Playwright e observacao

Reaproveitar o runner/recorder existentes, nao criar um segundo motor.
Cuidados estabelecidos:
- Instalar mocks/storage antes do boot e observadores antes da acao.
- Correlacionar por identidade da Request, nao apenas metodo/URL.
- Diferenciar HTTP 4xx/5xx de falha de transporte.
- Aguardar handlers pendentes, coletar responseEnd ao terminar e limpar listeners.
- Limitar origens, tamanhos e tipos de bodies; manter raw fora do canal do agente.
- Preferir sinais explicitos de conclusao a networkidle generico.
- Usar reset de backend quando necessario; contexto novo nao desfaz uma gravacao.
- Snapshot ARIA integral e evidencia adicional, nao substitui assertivas criticas.

Referencias originais:
[Request](https://playwright.dev/docs/api/class-request),
[Locator](https://playwright.dev/docs/api/class-locator),
[Page](https://playwright.dev/docs/api/class-page).
A implementacao esta fixada no Playwright 1.63.0; conferir API/versionamento antes
de alterar o pin, sem tratar paginas de documentacao futura como suporte instalado.

## 8. Privacidade, seguranca e acessibilidade

Minimizar dados, negar campos sensiveis, usar allowlists, pseudonimizacao e projecao
segura. Regex nao e detector universal de dados pessoais. Comparacao de valores
pode acontecer dentro do harness sem enviar esses valores ao agente.

Raw traces, cookies, Authorization, segredos e dados pessoais desnecessarios nao
entram no contexto do assistente. Conteudo de repositorio/runtime nao pode mudar
instrucoes confiaveis. Mesmo usuario no filesystem nao e isolamento por sandbox.
Hashes sao integridade, nao assinatura de aprovacao ou autenticacao de procedencia.

Referencias de seguranca:
[OWASP prompt injection](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html),
[OWASP coding with AI](https://cheatsheetseries.owasp.org/cheatsheets/Secure_Coding_with_AI_Cheat_Sheet.html).

ARIA parity e axe nao provam conformidade WCAG. Avaliacao humana permanece separada.
Referencias: [WCAG 2.2](https://www.w3.org/TR/WCAG22/),
[ACT rules](https://www.w3.org/WAI/WCAG22/Understanding/understanding-act-rules.html).

## 9. Consequencias para o plano atual

Manter: evidencias independentes, criterios protegidos, incerteza explicita,
diagnosticos localizados e o primeiro fluxo real antes de generalizar.

Revisar: contrato/brief/manifest obrigatorios, isolamento por conversa como regra
universal, reparos limitados ao que um codemod sabe fazer e descoberta como barreira
para um agente que consegue ler o codigo.

Investir agora: comparacao precisa, comandos reais do destino, suite consolidada,
referencia estavel, identificacao do build e ciclo de correcao autonomo limitado.
Detalhes normativos ficam na RFC; checklists e proximas tarefas somente no PLAN.
