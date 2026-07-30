const accounts = ['msc-nennung', 'msc-info', 'msc-vorstand'];
const readOutput = (result) => {
  if (typeof result === 'string') return result;
  if (result && typeof result.output === 'string') return result.output;
  if (result && typeof result.stdout === 'string') return result.stdout;
  if (Array.isArray(result && result.content)) {
    return result.content
      .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('');
  }
  throw new Error('MSC mail watcher received no readable command output');
};
const current = {};
const incoming = {};
for (const account of accounts) {
  const result = await tools.call('exec', {
    command: `/usr/local/bin/msc-mail-readonly list --account ${account} --folder INBOX`,
    timeoutMs: 20000,
  });
  const envelope = JSON.parse(readOutput(result));
  if (
    envelope.schema !== 'msc.mail-provider.v1' ||
    envelope.operation !== 'list' ||
    envelope.source?.account !== account ||
    typeof envelope.source?.sender_identity !== 'string' ||
    !Array.isArray(envelope.data)
  ) {
    throw new Error(`MSC mail watcher rejected the ${account} provider envelope`);
  }
  const own = envelope.source.sender_identity.toLowerCase();
  const ids = [];
  const external = [];
  for (const message of envelope.data.slice(0, 200)) {
    const id = String(message?.id ?? '');
    const from = message?.from?.addr;
    if (!/^[1-9][0-9]{0,17}$/.test(id)) {
      throw new Error(`MSC mail watcher rejected a ${account} message id`);
    }
    ids.push(id);
    if (typeof from === 'string' && from.toLowerCase() !== own) external.push(id);
  }
  current[account] = ids;
  incoming[account] = external;
}
const prior = trigger.state && trigger.state.version === 3
  ? trigger.state
  : null;
const nextState = { version: 3, seen: current };
if (!prior) return json({ state: nextState });
const events = [];
for (const account of accounts) {
  const seen = new Set(Array.isArray(prior.seen?.[account])
    ? prior.seen[account]
    : []);
  for (const messageId of incoming[account]) {
    if (!seen.has(messageId)) events.push({ account, messageId });
  }
}
return json({
  state: nextState,
  ...(events.length ? { fire: { events } } : {}),
});
