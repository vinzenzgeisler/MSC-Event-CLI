import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { registerApprovedActionPreviewPlugin } from '../dist/src/plugin-runtime.js';

export default definePluginEntry({
  id: 'msc-approved-actions-preview',
  name: 'MSC Approved Actions Preview',
  description: 'Inert, hash-bound approval previews without any mutation transport.',
  register: registerApprovedActionPreviewPlugin,
});
