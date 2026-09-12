import { Component, EventEmitter, Input, Output } from '@angular/core';
import { SeletorQuantidade } from './seletor-quantidade';
import { formatarMoeda, type PedidoConfirmado } from './design-system';

/**
 * Unidade B: consome a Unidade A (ordenação por dependência) e deriva o total de quantidade x preço unitário.
 * O callback onConfirmar não dispara rede: o host registra o payload como texto no DOM (efeito observável).
 */
@Component({
  selector: 'app-formulario-pedido', standalone: true, imports: [SeletorQuantidade], template: `
  <div class="ds-card pedido">
    <p class="ds-field__rotulo">Preço unitário {{ moeda(precoUnitario) }}</p>
    <app-seletor-quantidade [valor]="quantidade" [minimo]="0" [maximo]="10"
      rotulo="Quantidade do pedido" (onChange)="quantidade = $any($event)" />
    <p class="ds-field__rotulo">Total do pedido</p>
    <output class="ds-valor pedido__total" role="status" aria-label="Total">{{ moeda(quantidade * precoUnitario) }}</output>
    <p class="ds-ajuda">A confirmação registra o pedido no host, sem requisição de rede.</p>
    <button class="ds-btn" type="button" (click)="confirmar()">Confirmar pedido</button>
  </div>`
})
export class FormularioPedido {
  @Input() precoUnitario = 0;
  @Output() readonly onConfirmar = new EventEmitter<PedidoConfirmado>();
  quantidade = 1;

  moeda(valor: number): string { return formatarMoeda(valor); }

  confirmar(): void {
    this.onConfirmar.emit({ quantidade: this.quantidade, precoUnitario: this.precoUnitario,
      total: formatarMoeda(this.quantidade * this.precoUnitario) });
  }
}
