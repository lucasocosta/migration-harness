import { Component, EventEmitter, Input, Output } from '@angular/core';

/**
 * Unidade A: componente sem rota própria, exercitado pelos hosts autorizados.
 * Props de entrada (valor, minimo, maximo, rotulo) e callback onChange; o estado pertence a quem usa.
 * Botões nativos: Tab foca, Enter/Espaço ativam; desabilitados nos limites mínimo e máximo.
 */
@Component({
  selector: 'app-seletor-quantidade', standalone: true, template: `
  <div class="ds-field seletor">
    <p class="ds-field__rotulo">{{ rotulo }}</p>
    <button class="ds-btn seletor__passo" type="button" aria-label="Diminuir quantidade"
      [disabled]="valor <= minimo" (click)="alterar(-1)">-</button>
    <output class="ds-valor seletor__valor" role="status" aria-label="Quantidade atual">{{ valor }}</output>
    <button class="ds-btn seletor__passo" type="button" aria-label="Aumentar quantidade"
      [disabled]="valor >= maximo" (click)="alterar(1)">+</button>
    <p class="ds-ajuda">Permitido entre {{ minimo }} e {{ maximo }}.</p>
  </div>`
})
export class SeletorQuantidade {
  @Input() valor = 0;
  @Input() minimo = 0;
  @Input() maximo = 10;
  @Input() rotulo = 'Quantidade';
  @Output() readonly onChange = new EventEmitter<number>();

  alterar(passo: number): void {
    const proximo = this.valor + passo;
    if (proximo < this.minimo || proximo > this.maximo) return;
    this.onChange.emit(proximo);
  }
}
