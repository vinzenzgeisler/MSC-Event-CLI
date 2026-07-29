import { registerMscMailProductionPlugin } from '../dist/src/msc-mail-production-plugin.js';

export default {
  id: 'msc-approved-mail',
  name: 'MSC Approved Mail',
  description: 'Operator-approved MSC mail replies with encrypted state and exact-once dispatch.',
  register: registerMscMailProductionPlugin,
};
