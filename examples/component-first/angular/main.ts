import 'zone.js';
import '@angular/compiler';
import { NgIf } from '@angular/common';
import { Component } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { SeletorQuantidade } from './seletor-quantidade';
import { FormularioPedido } from './formulario-pedido';
import { formatarPedido, type PedidoConfirmado } from './design-system';

/**
 * Source side of the component-first example: two authorized hosts, one per unit, reached by path.
 * Each host is the unit's semantic boundary (unitScope role=main); the index route is the only shell.
 */
@Component({
  selector: 'harness-root', standalone: true, imports: [NgIf, SeletorQuantidade, FormularioPedido], template: `
  <main class="ds-page" aria-label="Host seletor de quantidade" *ngIf="rota === 'seletor'">
    <h1 class="ds-titulo">SeletorQuantidade isolado</h1>
    <app-seletor-quantidade [valor]="quantidade" [minimo]="0" [maximo]="5"
      rotulo="Quantidade" (onChange)="quantidade = $any($event)" />
    <p class="ds-field__rotulo">Valor recebido pelo host via onChange</p>
    <p class="ds-alerta" role="status" aria-label="Valor enviado pelo host">{{ quantidade }}</p>
  </main>
  <main class="ds-page" aria-label="Host formulario de pedido" *ngIf="rota === 'pedido'">
    <h1 class="ds-titulo">FormularioPedido isolado</h1>
    <app-formulario-pedido [precoUnitario]="10" (onConfirmar)="confirmado = pedido($any($event))" />
    <p class="ds-alerta" role="alert" aria-label="Pedido confirmado" [hidden]="confirmado === null">{{ confirmado }}</p>
  </main>
  <main class="ds-page" aria-label="Indice de hosts do exemplo" *ngIf="rota === 'indice'">
    <h1 class="ds-titulo">Hosts autorizados do exemplo</h1>
    <ul class="ds-lista">
      <li><a href="/host/seletor">Unidade A: seletor de quantidade</a></li>
      <li><a href="/host/pedido">Unidade B: formulário de pedido</a></li>
    </ul>
  </main>`
})
class ComponentFirstHosts {
  rota: 'indice' | 'seletor' | 'pedido' = location.pathname === '/host/seletor' ? 'seletor'
    : location.pathname === '/host/pedido' ? 'pedido' : 'indice';
  quantidade = 2;
  confirmado: string | null = null;

  pedido(payload: PedidoConfirmado): string { return formatarPedido(payload); }
}
void bootstrapApplication(ComponentFirstHosts);
