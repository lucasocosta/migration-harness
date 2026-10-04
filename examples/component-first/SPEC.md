# SPEC — exemplo component-first (caso de uso P6)

Dados sinteticos; nada deriva de traces. Perfil: **standard**. Esta SPEC declara
as unidades, a ordenacao por dependencia e os hosts autorizados; os criterios
executaveis vivem em `migration.json` (5 cenarios, 11 requisitos unit-scope,
3 checks). Execucao registrada em `docs/archive/VALIDATION.md` (2026-09-12).

## Unidades e integracao

| Unidade | Origem | Destino/rota/host | Dependencias | Escopo de edicao |
| --- | --- | --- | --- | --- |
| `seletor-quantidade` | componente sem rota (Angular standalone) | host `/host/seletor` nos dois lados | nenhuma | `react/SeletorQuantidade.tsx`, `react/App.tsx` |
| `formulario-pedido` | componente sem rota que consome a Unidade A | host `/host/pedido` nos dois lados | `seletor-quantidade` | `react/FormularioPedido.tsx`, `react/App.tsx` |

Ordenacao: `formulario-pedido` depende de `seletor-quantidade` (A -> B). A
verificacao por unidade acontece nos cenarios de A; a suíte integrada final
(incluindo `pedido-fluxo-completo`) deve passar na mesma revisao final do
destino — PASS isolados por unidade em revisoes diferentes nao aprovam o conjunto.

## Hosts autorizados

- Origem (Angular, :4210): `/host/seletor`, `/host/pedido` renderizam os
  componentes isolados; callbacks registrados como texto no DOM do host.
- Destino (React, :5175): mesmas rotas e nomes acessiveis; `onChange`/`onConfirmar`
  ligados ao DOM pelo host (`role="status"` / `role="alert"`).

## Diferencas esperadas

Nenhuma. O exemplo nao declara `acceptedDifferences`; qualquer divergencia e
defeito do candidato. Sem mocks de API: os hosts sao estaticos, e o efeito do
confirm e somente-DOM (`NO_REQUEST` documenta isso).

## Limites de cobertura

Cobertura declarada: caminhos felizes de A/B, limites min/max, teclado nativo
(Enter/Espaco via `press`), callback por efeito observavel e regressao nativa do
design system protegido. Nao coberto: faixas de entrada exaustivas, paridade
visual, persistencia (sem rede) e captura direta de valor de callback.
