/**
 * Design system já existente no destino (fora do escopo de escrita do exemplo):
 * os componentes migrados devem reutilizar estes tokens e formatadores, não reimplementá-los.
 */
export const designTokens = {
  campo: 'ds-field', botao: 'ds-btn', valor: 'ds-valor', alerta: 'ds-alerta',
  titulo: 'ds-titulo', ajuda: 'ds-ajuda', cartao: 'ds-card', rotulo: 'ds-field__rotulo', pagina: 'ds-page',
};

/** Formata em reais com vírgula decimal: 10 -> "R$ 10,00". */
export const formatarMoeda = valor => `R$ ${valor.toFixed(2).replace('.', ',')}`;

/** Projeta o payload do callback onConfirmar como texto observável no DOM do host. */
export const formatarPedido = pedido =>
  `quantidade ${pedido.quantidade}, preço unitário ${formatarMoeda(pedido.precoUnitario)}, total ${pedido.total}`;
