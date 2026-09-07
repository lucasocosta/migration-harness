import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationName, canEdit } from './existing.mjs';
test('existing application identity and session permissions', () => {
  assert.equal(applicationName, 'Existing React');
  assert.equal(canEdit({ role: 'editor' }), true);
  assert.equal(canEdit({ role: 'viewer' }), false);
  assert.equal(canEdit(null), false);
});
