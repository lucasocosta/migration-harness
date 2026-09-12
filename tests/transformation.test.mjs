import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformAngularComponent, repairHttpMethod } from '../packages/codemods/dist/index.js';
import { MigrationEngineStateMachine } from '../packages/engine/dist/index.js';

test('codemod preserves HTTP body and fails closed for unsupported lifecycle', async () => {
  const source = await readFile('examples/angular-react-pilot/source/customer-profile.ts', 'utf8');
  const result = transformAngularComponent(source, 'unit');
  assert.match(result.code, /method: ['"]PUT['"]/);
  assert.match(result.code, /JSON.stringify\(\{ email: this.email \}\)/);
  assert.equal(result.manifest.transformer.kind, 'CODEMOD');
  assert.throws(() => transformAngularComponent(source.replace('async save()', 'async ngOnInit()'), 'unit'), /Lifecycle/);
  const changed = repairHttpMethod(result.code, 'POST', 'PUT');
  assert.match(changed, /method: "POST"/);
  assert.equal(repairHttpMethod(changed, 'PUT', 'POST').replace('"PUT"', "'PUT'"), result.code);
});
test('FSM cannot skip human review, repair budget cannot be externally increased', () => {
  const context = { repairAttempts: 0, maxRepairAttempts: 0 };
  const fsm = new MigrationEngineStateMachine(context); context.maxRepairAttempts = 99;
  fsm.start(); fsm.discoveryCompleted(); fsm.scenariosPrepared(); fsm.sourceTraceCompleted(3);
  assert.throws(() => fsm.contractApproved(), /CONTRACT_REVIEW/);
  fsm.synthesisCompleted();
  assert.equal(fsm.getState(), 'CONTRACT_REVIEW');
  fsm.contractApproved(); fsm.contractIntegrityVerified(); fsm.transformationPlanned(); fsm.transformCompleted(); fsm.targetTraceCompleted(); fsm.equivalenceEvaluated(false); fsm.failureClassified('AUTO_REPAIRABLE');
  assert.equal(fsm.getState(), 'ESCALATE_PR');
});
