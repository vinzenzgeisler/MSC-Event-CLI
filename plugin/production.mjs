import { registerMscMailProductionPlugin } from '../dist/src/msc-mail-production-plugin.js';

export default {
  id: 'msc-approved-mail',
  name: 'MSC Operations',
  description: 'Typed MSC reads and approval-gated registration and mail operations.',
  register: registerMscMailProductionPlugin,
};
