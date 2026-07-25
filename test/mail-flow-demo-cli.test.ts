import assert from 'node:assert/strict';
import test from 'node:test';
import { runMailFlowDemo } from '../src/mail-flow-demo-cli.js';

test('shows the complete five-step flow without network or duplicate delivery', async () => {
  const result = await runMailFlowDemo();
  assert.equal(result.demo, true);
  assert.equal(result.networkUsed, false);
  assert.equal(result.deliveryCount, 1);
  assert.equal(result.finalStatus, 'accepted');
  assert.deepEqual(
    result.stages.map((stage) => stage.title),
    [
      'Mail lesen',
      'Antwort entwerfen',
      'Vollständige Vorschau',
      'Passkey-Freigabe',
      'Versandstatus',
    ],
  );
});
