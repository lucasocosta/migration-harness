# Especificacao de migracao Angular -> React existente

Preencher os campos antes de autorizar a transformacao. Nao executar marcadores
`<...>` como comandos. Complementa AGENTS.md; nao concede permissao para alterar
contratos aprovados, gates ou o harness.

## Identificacao

- Nome da migracao: <nome>
- Modo: <aplicacao | pagina | componente>
- Responsavel humano: <nome>
- Revisor do contrato: <nome>
- Revisor de codigo/acessibilidade: <nome>
- Origem: apps/angular
- Destino existente: apps/react
- Commit/branch da origem: <referencia fixa>
- Branch de trabalho do React: <migration/nome>
- Pasta de acompanhamento: migrations/<nome>
- Raiz de evidencias publicas: artifacts/<nome>
- Autorizacao para commit: <nao | apos revisao>
- Merge/push/remocao da origem: proibidos sem pedido explicito separado.

## Objetivo e exclusoes

Migrar <escopo concreto> e integrar ao React existente preservando <obrigacoes>.
Nao criar outra aplicacao React, trocar framework/roteador/gerenciador ou remover
funcionalidades existentes. Fora do escopo: <lista>.

## Contrato de integracao do destino

- Roteador e locais de registro de rotas: <arquivos>
- Design system/componentes reutilizaveis: <arquivos>
- Autenticacao/autorizacao: <contratos e arquivos; sem segredos>
- Cliente HTTP/base URL/interceptors: <arquivos>
- Estado/cache/consultas: <padroes existentes>
- Formularios/validacao: <padroes existentes>
- Estilos, i18n, erros e notificacoes: <padroes existentes>
- Dependencias ja aprovadas: <pacotes>
- Imports/aliases que exigem configuracao do projeto: <lista>
- Funcionalidades do React que devem continuar intactas: <lista>

## Preparacao autorizada

Nesta fase o agente pode ler apenas os repositorios/arquivos explicitamente
autorizados abaixo e elaborar inventario/propostas. Essa autorizacao nao inclui
transformar candidatos nem aprovar o proprio oraculo.

- Leituras Angular: <pastas/arquivos de codigo sem segredos>
- Leituras React: <pastas/arquivos de codigo sem segredos>
- Escritas de acompanhamento autorizadas: <SPEC.md, units.md, propostas>
- Quem prepara/revisa cenarios e fixtures: <responsavel>
- Quem inicia os servidores/comandos revisados: <responsavel>
- Proibidos: raw traces, .env, chaves, tokens, producao e arquivos de outras unidades.

O responsavel aprova o inventario e emite briefs. A fase de transformacao usa apenas
contextFiles/allowedFiles do brief, mesmo que a preparacao tivesse leitura mais ampla.
Uma prova de sessao brief-only requer conversa limpa, sem esse contexto anterior.

## Unidades

Para aplicacao completa, repetir esta secao e ordenar por dependencias. Nao pedir
uma conversao monolitica de toda a arvore de arquivos.

- Unit ID: <id emitido/validado pela descoberta>
- Source root: apps/angular/src
- Entrypoint: <caminho relativo#Simbolo>
- Rota Angular / rota host de teste: <caminho>
- Rota React / rota host de teste: <caminho compativel com o cenario>
- Arquivos gravaveis, relativos ao React: <TS/TSX, lista fechada>
- Contexto Angular adicional somente leitura: <templates/estilos/contratos>
- Contexto React somente leitura: <componentes/imports/package.json/convencoes>
- Dependencias de outras unidades: <lista>
- Integracoes nao TS/TSX que exigem tarefa separada: <lista>
- Numero maximo de reparos autorizados: <numero>

## Comportamentos obrigatorios

- Inputs/props e valores iniciais: <lista>
- Outputs/callbacks e efeitos: <lista>
- HTTP: <metodos, endpoints, campos obrigatorios, status esperados>
- Navegacao/permissoes: <lista>
- Formularios e mensagens de validacao: <lista>
- Loading, vazio, erro, cancelamento e concorrencia: <lista>
- Storage/estado observavel: <lista>
- Acessibilidade e interacoes de teclado: <lista>
- Comportamentos deliberadamente diferentes, aprovados pelo responsavel: <lista>

Observacoes de runtime sao evidencias, nao requisitos automaticamente aprovados.
Cada obrigacao critica deve ter a origem/revisao registrada no contrato.

## Ambiente, cenarios e verificacao

- URL Angular: <http://localhost:porta>
- URL React: <http://localhost:porta>
- Origens adicionais autorizadas: <lista minima>
- Dados sinteticos/contas de teste: <referencias publicas, sem credenciais>
- Mock fixtures e reset entre execucoes: <arquivos e procedimento>
- Cenarios obrigatorios: <sucesso, erro, borda, permissao etc.>
- Sinais de conclusao explicitos: <por cenario/passo>
- Service workers: <block | opt-in limitado e revisado>
- Politica de sanitizacao/volatilidade: <arquivo revisado>
- Contrato aprovado: <arquivo e hash verificado>
- Comandos Angular revisados: <instalar, iniciar, verificar>
- Comandos React revisados: <instalar, iniciar, typecheck, lint, testes, build>
- Fronteira aprovada para execucao de candidatos: <ambiente/sandbox; nao presumir Docker disponivel>
- Suite de regressao do React existente: <comandos e cenarios>

## Ordem de execucao para o Copilot

1. Ler AGENTS.md e esta especificacao; informar lacunas e nao inventar requisitos.
2. Na preparacao, inventariar unidades e pontos de integracao autorizados.
3. Aguardar cenarios/contrato revisados e brief emitido pelo harness.
4. Na transformacao, ler somente brief, contextFiles e allowedFiles autorizados.
5. Produzir submissao JSON com briefId, hashes originais, patches completos e manifest.
6. Executar apply-patch. Nunca escrever diretamente os candidatos fora desse fluxo.
7. Verificar o resultado emitido, reconstruir o React pelos comandos aprovados e
   executar run --max-repairs 0 para todos os cenarios obrigatorios.
8. Executar gates/regressao do projeto real. PASS de aplicacao nao e EQUIVALENT.
9. Reparar somente com brief autorizado; respeitar limite e parar em escalacoes.
10. Atualizar units.md com evidencias, pendencias e bloqueios. Preparar diff para
    revisao humana; commit apenas se autorizado; nunca merge/push automaticos.

## Criterios de parada

Parar e informar o responsavel se faltar escopo/contexto, houver hash obsoleto,
dependencia nao aprovada, semantica sem cenarios suficientes, necessidade de alterar
oraculo/gates, segredo nos dados, falha de integridade, lock pendente ou ambiente de
execucao inseguro. Nao ampliar allowlists nem enfraquecer politica por conta propria.

## Entrega por unidade

- [ ] Contrato humano aprovado e hash intacto.
- [ ] Brief e submissao identificados por artefatos.
- [ ] APPLY_RESULT PASS emitido pelo harness.
- [ ] Todos os cenarios obrigatorios EQUIVALENT, com caminhos dos resultados.
- [ ] Build/typecheck/lint/testes reais do React aprovados.
- [ ] Regressao das funcionalidades existentes aprovada.
- [ ] Revisao humana de codigo e acessibilidade registrada.
- [ ] Diff limitado ao escopo e checklist atualizado.
- [ ] Commit autorizado no repositorio React, sem segredos/evidencias privadas.

Esses itens sao pendencias ate haver evidencia. Nenhum agente pode marca-los como
concluidos apenas porque gerou codigo ou porque seus proprios testes parecem passar.
