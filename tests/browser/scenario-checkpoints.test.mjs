import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureScenario } from '../../packages/engine/dist/scenario-runner/index.js';
import { sanitizeTrace } from '../../packages/core/dist/trace-sanitizer/index.js';
import { evaluateUnitAssertions } from '../../packages/engine/dist/equivalence/index.js';

test('explicit checkpoints record busy state, sequenced responses and text-specific completion in fresh contexts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scenario-checkpoints-'));
  const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end(`<main><button>Save</button><p role="status">Idle</p><script>
    document.querySelector('button').onclick=async()=>{const b=document.querySelector('button'),p=document.querySelector('p');
      b.disabled=true;p.textContent='Saving';const r=await fetch('/save',{method:'PUT',body:'{}'});b.disabled=false;
      p.textContent=r.ok?'Saved':'Failed';};</script></main>`); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await writeFile(join(root, 'response.json'), '{}');
    const url = `http://127.0.0.1:${server.address().port}`;
    const visible = text => ({ type: 'LOCATOR_VISIBLE', targetRole: 'status', text, timeoutMs: 5000 });
    const scenario = { scenarioId: 'retry', unitId: 'form', name: 'Retry', description: 'Synthetic delayed response', entryUrl: url,
      captureStepCheckpoints: true, testDataProfile: 'standard',
      preconditions: { mockInitialApiResponses: [{ urlPattern: '**/save', method: 'PUT', statusCode: 400, fixturePath: 'response.json', delayMs: 600,
        sequence: [{ statusCode: 200, fixturePath: 'response.json', delayMs: 600 }] }] },
      steps: [
        { stepId: 'save', action: 'click', targetRole: 'button', targetName: 'Save', completionSignal: visible('Saving') },
        { stepId: 'failure', action: 'focus', targetRole: 'main', completionSignal: visible('Failed') },
        { stepId: 'retry', action: 'click', targetRole: 'button', targetName: 'Save', completionSignal: visible('Saved') },
      ] };
    for (let runIndex = 0; runIndex < 2; runIndex++) {
      const trace = sanitizeTrace(await captureScenario(scenario, runIndex, { fixtureBaseDir: root }), { pseudonymizationKey: 'test-only-key'.repeat(4) });
      assert.deepEqual(trace.events.filter(event => event.type === 'HTTP_RESPONSE').map(event => event.statusCode), [400, 200]);
      const assertions = [
        { id: 'busy', required: true, checkpoint: { kind: 'AFTER_STEP', stepId: 'save' }, claim: { kind: 'NODE_PRESENT', role: 'button', name: 'Save', state: { disabled: true } } },
        { id: 'failure', required: true, checkpoint: { kind: 'AFTER_STEP', stepId: 'failure' }, claim: { kind: 'NODE_PRESENT', role: 'status', text: 'Failed' } },
        { id: 'saved', required: true, checkpoint: { kind: 'SCENARIO_END' }, claim: { kind: 'NODE_PRESENT', role: 'status', text: 'Saved' } },
        { id: 'cleared', required: true, checkpoint: { kind: 'SCENARIO_END' }, claim: { kind: 'NODE_ABSENT', role: 'status', text: 'Failed' } },
      ];
      assert.equal(evaluateUnitAssertions({ source: trace, target: trace, assertions }).outcomes.every(item => item.status === 'SATISFIED'), true);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
