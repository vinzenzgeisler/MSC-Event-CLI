#!/usr/bin/env node
import { runPasskeyBootstrapOperator } from './passkey-bootstrap-operator.js';

try {
  await runPasskeyBootstrapOperator(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    error: 'BOOTSTRAP_OPERATOR_FAILED',
    message: error instanceof Error ? error.message : 'Bootstrap command failed.',
  })}\n`);
  process.exitCode = 1;
}
