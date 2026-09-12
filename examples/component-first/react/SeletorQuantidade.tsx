import React from 'react';
import { designTokens } from './design-system.mjs';

export interface SeletorQuantidadeProps {
  valor: number;
  minimo: number;
  maximo: number;
  rotulo: string;
  onChange: (valor: number) => void;
}

/**
 * Unidade A — componente sem rota própria, exercitado pelos hosts autorizados.
 * Props de entrada (valor, minimo, maximo, rotulo) e callback onChange; o estado pertence a quem usa.
 * Botões nativos: Tab foca, Enter/Espaço ativam; desabilitados nos limites mínimo e máximo.
 */
export function SeletorQuantidade({ valor, minimo, maximo, rotulo, onChange }: SeletorQuantidadeProps) {
  const alterar = (passo: number) => {
    const proximo = valor + passo;
    if (proximo < minimo || proximo > maximo) return;
    onChange(proximo);
  };
  return (
    <div className={`${designTokens.campo} seletor`}>
      <p className={designTokens.rotulo}>{rotulo}</p>
      <button
        className={designTokens.botao}
        type="button"
        aria-label="Diminuir quantidade"
        disabled={valor <= minimo}
        onClick={() => alterar(-1)}
      >-</button>
      <span className={designTokens.valor} role="status" aria-label="Quantidade atual">{valor}</span>
      <button
        className={designTokens.botao}
        type="button"
        aria-label="Aumentar quantidade"
        disabled={valor >= maximo}
        onClick={() => alterar(1)}
      >+</button>
      <p className={designTokens.ajuda}>Permitido entre {minimo} e {maximo}.</p>
    </div>
  );
}
