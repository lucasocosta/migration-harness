/** Helpers do design system do exemplo (origem). O destino mantém a mesma contrato em design-system.mjs. */
export interface PedidoConfirmado {
  quantidade: number;
  precoUnitario: number;
  total: string;
}

/** Formata em reais com vírgula decimal: 10 -> "R$ 10,00". */
export const formatarMoeda = (valor: number): string => `R$ ${valor.toFixed(2).replace('.', ',')}`;

/** Projeta o payload do callback onConfirmar como texto observável no DOM do host. */
export const formatarPedido = (pedido: PedidoConfirmado): string =>
  `quantidade ${pedido.quantidade}, preço unitário ${formatarMoeda(pedido.precoUnitario)}, total ${pedido.total}`;
