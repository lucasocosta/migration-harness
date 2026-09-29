import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVisualCheckpoints, visualCheckpoints, hashImage, EquivalenceValidator, migrationComparisonPolicy,
} from '../packages/equivalence-validator/dist/index.js';
import { parseSanitizedTrace } from '../packages/core/dist/index.js';
import { event } from './helpers.mjs';

function traceWithVisual(options = {}) {
  const {
    scenarioId = 'update-customer',
    checkpoints = [{ triggerEventId: 'initial_mount', sha: 'a'.repeat(64), width: 100, height: 50 }],
  } = options;
  const value = {
    scenarioId, runIndex: 1, startedAt: '2026-09-05T00:00:00.000Z',
    environment: { browser: 'chromium', viewport: { width: 1280, height: 720 }, locale: 'pt-BR' },
    sanitization: { version: 'test', appliedAt: '2026-09-05T00:00:01.000Z', redactionsCount: 0 },
    events: [],
  };
  event(value, 'USER_INTERACTION', { stepId: 'save', action: 'click', targetAriaRole: 'button', targetAriaName: 'Salvar' });
  for (const checkpoint of checkpoints) {
    event(value, 'VISUAL_CHECKPOINT', {
      triggerEventId: checkpoint.triggerEventId,
      imageSha256: checkpoint.sha,
      width: checkpoint.width,
      height: checkpoint.height,
    });
  }
  return parseSanitizedTrace(value);
}

test('visual checkpoints are structural hashes only; bytes never enter the event', () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  assert.equal(hashImage(bytes).length, 64);
  const trace = traceWithVisual();
  const list = visualCheckpoints(trace);
  assert.equal(list.length, 1);
  assert.equal(list[0].imageSha256, 'a'.repeat(64));
  assert.ok(!JSON.stringify(trace).includes('iVBOR') && !JSON.stringify(trace).includes('89504e47'));
});

test('compareVisualCheckpoints reports WARNING mismatches without blocking by default', () => {
  const source = traceWithVisual();
  const target = traceWithVisual({ checkpoints: [{ triggerEventId: 'initial_mount', sha: 'b'.repeat(64), width: 100, height: 50 }] });
  const divergences = compareVisualCheckpoints(source, target);
  assert.equal(divergences.length, 1);
  assert.equal(divergences[0].code, 'VISUAL_MISMATCH');
  assert.equal(divergences[0].dimension, 'VISUAL');
  assert.equal(divergences[0].severity, 'WARNING');
  assert.ok(!JSON.stringify(divergences).includes('base64'));

  const blocking = compareVisualCheckpoints(source, target, { severity: 'BLOCKING' });
  assert.equal(blocking[0].severity, 'BLOCKING');

  const identical = compareVisualCheckpoints(source, source);
  assert.deepEqual(identical, []);

  const missing = compareVisualCheckpoints(source, traceWithVisual({ checkpoints: [] }));
  assert.equal(missing[0].code, 'VISUAL_MISMATCH');
  assert.match(missing[0].message, /missing-on-/);
});

test('EquivalenceValidator only evaluates visual when policy.visual.enabled', () => {
  const source = traceWithVisual();
  const target = traceWithVisual({ checkpoints: [{ triggerEventId: 'initial_mount', sha: 'b'.repeat(64), width: 10, height: 10 }] });
  const off = new EquivalenceValidator().validate({ source, target, policy: migrationComparisonPolicy({}) });
  assert.ok(!off.divergences.some(item => item.dimension === 'VISUAL'));
  assert.ok(!off.evidence.evaluatedDimensions.includes('VISUAL'));

  const on = new EquivalenceValidator().validate({
    source, target,
    policy: { ...migrationComparisonPolicy({}), visual: { enabled: true } },
  });
  assert.ok(on.divergences.some(item => item.code === 'VISUAL_MISMATCH' && item.severity === 'WARNING'));
  assert.ok(on.evidence.evaluatedDimensions.includes('VISUAL'));
  // WARNING visual mismatch alone does not flip a clean behavioral verdict to NOT_EQUIVALENT
  // when nothing else blocks — preservation stays about required dimensions.
  assert.equal(on.status, 'EQUIVALENT');
});
