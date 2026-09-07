# Manual de migracao com Copilot

Atualizado: 2026-09-06. Direcao: [RFC v0.3](RFC.md).
**O fluxo padrao ponta a ponta ainda esta em implementacao planejada.**
Este manual distingue a experiencia desejada dos comandos disponiveis hoje.
Veja [STATUS.md](STATUS.md), [PLAN.md](PLAN.md) e [USAGE.md](USAGE.md).

## 1. O que voce entrega e recebe

Voce informa o que migrar, origem/destino e diferencas aceitaveis. O agente levanta
os detalhes tecnicos, prepara a verificacao, implementa e corrige usando o harness.
A entrega e codigo integrado ao React existente mais evidencia, cobertura e limites.

O mesmo agente pode conduzir tudo na mesma conversa. O harness emite resultados;
o agente os interpreta e corrige o codigo. Nao precisa de API de modelo adicional.

## 2. Pasta e especificacao

```text
migration-harness/
  apps/angular/                 # clone com Git proprio
  apps/react/                   # clone existente com Git proprio
  migrations/<nome>/
    SPEC.md                     # escopo e decisoes; agente completa detalhes
    units.md                    # feito/pendente/bloqueado com evidencia
    scenarios/fixtures/         # cenarios e dados sinteticos
  artifacts/<nome>/             # resultados publicos permitidos
```

Use [o template](templates/MIGRATION-SPEC.md). Nao clone sobre pastas existentes,
descarte alteracoes locais ou substitua o React por um scaffold. Preserve roteador,
design system, autenticacao, cliente HTTP e funcionalidades anteriores.

apps/, migrations/ e artifacts/ sao ignorados pelo Git do harness. Os clones tem
historicos independentes; especificacoes e evidencias permitidas precisam de
versionamento autorizado separado. Nunca versione raw traces/chaves/credenciais.

## 3. Fluxo padrao proposto

1. O agente le o escopo e codigo relevante, inventaria integracoes e comandos reais.
2. Prepara cenarios de sucesso, erro e borda; dados/reset; criterios observaveis e
   diferencas intencionais. Pergunta somente por ambiguidade ou autorizacao real.
3. O harness verifica a estabilidade do Angular e registra uma referencia versionada.
4. O agente edita normalmente o destino dentro do escopo, inclusive estilos e testes.
5. O harness executa comandos do projeto, serve o build atual, verifica os cenarios
   nas duas aplicacoes e a regressao do React, entregando um relatorio consolidado.
6. O agente corrige defeitos e repete dentro do limite. Ao final, executa a suite
   completa, registra evidencias e apresenta o resultado para revisao.

Contrato formal, brief, manifest e submissao JSON nao sao obrigatorios neste perfil.
Referencia, criterios e evidencias continuam protegidos. Uma diferenca detectada
nao autoriza retirar o teste. Adicoes de cobertura/bindings geram nova versao e
reexecucao; reducao de criterios ou novas diferencas aceitas exigem revisao humana.

**P1-P4 do plano precisam existir antes de executar esse fluxo como produto.**
Na transicao, nao use os agentes restritos para simular essas permissoes.

## 4. Instrucao para o agente

Modelo de instrucao para o perfil padrao, apos sua disponibilizacao:

```text
Leia AGENTS.md, docs/STATUS.md e migrations/<nome>/SPEC.md.
Confirme que o perfil padrao esta implementado e autorizado nesta especificacao.
Se nao estiver, relate a capacidade ausente; nao invente comandos nem burle o restrito.
Conduza a migracao ponta a ponta no React existente usando suas capacidades.
Prepare cenarios e dados sinteticos, valide a referencia Angular e registre cobertura.
Implemente dentro do escopo, execute o harness e os checks reais do projeto,
analise as diferencas e corrija ate atender aos criterios ou esgotar o limite.
Nao altere origem, criterios ou evidencias para fazer o resultado passar.
Pergunte por decisoes de negocio, permissoes ou mudancas de escopo; resolva os
detalhes tecnicos autorizados. Nao leia segredos/raw traces.
Atualize units.md com feito, pendente, bloqueios e resultados efetivamente emitidos.
Entregue diff, relatorio, cobertura e limitacoes. Respeite autorizacao de commit;
nao faca merge, push ou remova a origem automaticamente.
```

Voce nao precisa escrever manualmente todos os arquivos de configuracao. O template
separa escolhas do responsavel e detalhes que o agente consegue levantar.

## 5. O que funciona hoje

[USAGE.md](USAGE.md) e a referencia executavel:
- `trace`: uma captura de cenario, com aplicacao ja servida.
- `compare`: compara traces sanitizados; contrato e manifest sao opcionais.
- `run`: exige contrato aprovado, apps ja servidas e um cenario por chamada.
- `brief / apply-patch`: perfil restrito, nao um migrador autonomo padrao.

O perfil restrito continua disponivel quando explicitamente escolhido, conforme
[ASSISTANT-INTEGRATION.md](ASSISTANT-INTEGRATION.md) e AGENTS.md. Os agentes
`migracao-preparacao` e `migracao-transformacao` pertencem apenas a ele:
preparacao sem terminal, transformacao via brief e sem escrita direta de candidato.
Nao desative seu hook para contornar uma recusa. A gravacao brief-only e uma
demonstracao desse perfil, nao um requisito geral de migracao.

Nenhum resultado atual compara automaticamente todos os valores de negocio.
PASS de apply nao e equivalencia. EQUIVALENT vale para os cenarios/dimensoes
executados, nao para tudo que esta na especificacao.

## 6. Pagina, componente e aplicacao

**Pagina:** incluir rota, dados carregados/salvos, validacao, permissoes, loading,
erros, reenvio e integracao. O shell existente pode diferir; a funcionalidade nao.

**Componente:** incluir props/inputs, callbacks/outputs, teclado e estados. Sem rota,
preparar hosts de teste autorizados para as duas implementacoes.

**Aplicacao:** inventariar unidades e dependencias, migrar incrementalmente e executar
regressao integrada. Nao tratar varios PASS isolados de revisoes diferentes como
aprovacao da aplicacao inteira.

## 7. Acompanhamento, seguranca e entrega

```markdown
| Unidade | Referencia | Implementacao | Comparacao | Regressao destino | Lacunas |
| --- | --- | --- | --- | --- | --- |
| editar-filme | pendente | pendente | pendente | pendente | sem evidencia ainda |
```

Registrar versao, tentativa, caminho de resultado e proxima acao. Nao marcar feito
por ter escrito codigo. Registrar checks preexistentes com falha e nao os chamar
de aprovados. PASS/FAIL/INCONCLUSIVE e a referencia versionada (com verificacao de
insumos e decisao do responsavel para enfraquecimento) ja existem como schema/API de
biblioteca na P1, mas ainda nao como operacao executavel de verificacao.

Dados sinteticos e reset sao o padrao; mocks nao provam persistencia sem verificacao
dos valores enviados/read-back pertinente. Raw traces ficam privados, nunca no
contexto do agente; em WSL, no filesystem Linux nativo. O acesso do mesmo usuario
nao e tecnicamente isolado. Executar apenas comandos em ambiente autorizado.

A conclusao exige suite obrigatoria completa no build atual, criterios intactos,
regressao do destino e limitacoes explicitas. Revisao humana de codigo e
acessibilidade continua distinta de verificacao automatizada.
Commit no repositorio React apenas conforme a especificacao; merge/push/remocao
da origem sempre dependem de pedido separado.
