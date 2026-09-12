import test from 'node:test';
import assert from 'node:assert/strict';
import { designTokens, formatarMoeda, formatarPedido } from './design-system.mjs';

test('existing design system tokens and formatters', () => {
  assert.equal(designTokens.botao, 'ds-btn');
  assert.equal(designTokens.valor, 'ds-valor');
  assert.equal(formatarMoeda(10), 'R$ 10,00');
  assert.equal(formatarMoeda(0.5), 'R$ 0,50');
  assert.equal(formatarPedido({ quantidade: 3, precoUnitario: 10, total: 'R$ 30,00' }),
    'quantidade 3, preço unitário R$ 10,00, total R$ 30,00');
});
