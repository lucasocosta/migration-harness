import React, { useState } from 'react';
import { SeletorQuantidade } from './SeletorQuantidade';
import { designTokens, formatarMoeda } from './design-system.mjs';

export interface PedidoConfirmado {
  quantidade: number;
  precoUnitario: number;
  total: string;
}

export interface FormularioPedidoProps {
  precoUnitario: number;
  onConfirmar: (pedido: PedidoConfirmado) => void;
}

/**
 * Unidade B: consome a Unidade A (ordenação por dependência) e deriva o total de quantidade x preço unitário.
 * O callback onConfirmar não dispara rede: o host registra o payload como texto no DOM (efeito observável).
 */
export function FormularioPedido({ precoUnitario, onConfirmar }: FormularioPedidoProps) {
  const [quantidade, setQuantidade] = useState(1);
  const total = formatarMoeda(quantidade * precoUnitario);
  return (
    <div className={`${designTokens.cartao} pedido`}>
      <p className={designTokens.rotulo}>Preço unitário {formatarMoeda(precoUnitario)}</p>
      <SeletorQuantidade valor={quantidade} minimo={0} maximo={10} rotulo="Quantidade do pedido"
        onChange={setQuantidade} />
      <p className={designTokens.rotulo}>Total do pedido</p>
      <span className={`${designTokens.valor} pedido__total`} role="status" aria-label="Total">{total}</span>
      <p className={designTokens.ajuda}>A confirmação registra o pedido no host, sem requisição de rede.</p>
      <button className={designTokens.botao} type="button"
        onClick={() => onConfirmar({ quantidade, precoUnitario, total })}>Confirmar pedido</button>
    </div>
  );
}
