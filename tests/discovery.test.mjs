import test from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../packages/static-analyzer/dist/index.js';

test('discovery resolves route ownership, guards, resolvers, constructor DI, selectors and aliases', async () => {
  const result = await discover('tests/fixtures/discovery', ['feature.ts#FeatureComponent']);
  assert.deepEqual(result.unit.runtimeRoutes, ['/customers/:id']);
  for (const relation of ['injects', 'renders', 'applies_directive', 'pipes_through', 'guards', 'resolves']) assert.ok(result.unit.dependencyGraph.some(edge => edge.relation === relation), relation);
  assert.equal(result.injections[0].lifetime, 'root');
  assert.ok(result.unit.symbols.some(symbol => symbol.name === 'CustomerService'));
  assert.ok(!result.unit.symbols.some(symbol => symbol.name === 'UnrelatedComponent'));
  assert.ok(result.routes.some(route => route.path === '/lazy' && route.dynamic));
  assert.ok(result.unit.resolutionMetrics.unresolvedSymbols.some(item => item.reason.includes('Dynamic')));
  assert.equal(result.unit.resolutionMetrics.resolvedSymbolsCount, result.unit.symbols.length);
  await assert.rejects(discover('tests/fixtures/discovery'), /explicit entrypoints/);
});
