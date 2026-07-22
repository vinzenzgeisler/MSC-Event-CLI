export type OutputFormat = 'json' | 'text';

export const parseFormat = (value: string): OutputFormat => {
  if (value !== 'json' && value !== 'text') throw new Error('Format must be json or text.');
  return value;
};

const formatMoney = (cents: number): string => `${(cents / 100).toFixed(2).replace('.', ',')} EUR`;

export const renderOutput = (value: unknown, format: OutputFormat): string => {
  if (format === 'json') return JSON.stringify(value, null, 2);
  if (typeof value !== 'object' || value === null) return String(value);
  const record = value as Record<string, unknown>;
  if (record.mode === 'full') return JSON.stringify(value, null, 2);
  if (record.status === 'not_found') return 'Kein Treffer.';
  if (record.status === 'ambiguous') {
    const candidates = (record.candidates as Array<Record<string, unknown>> | undefined) ?? [];
    return ['Mehrdeutiger Treffer:', ...candidates.map((item) => `- ${item.name ?? 'Unbekannt'} · ${item.orgaCode ?? 'ohne Orga-Code'}`)].join('\n');
  }
  const entries = (record.entries as Array<Record<string, unknown>> | undefined) ?? (record.entry ? [record.entry as Record<string, unknown>] : []);
  if (entries.length > 0) {
    return entries.map((item) => {
      const start = item.start as Record<string, unknown>;
      const payment = item.payment as Record<string, unknown>;
      const status = item.status as Record<string, unknown>;
      return [
        `${start.className ?? ''} · Start ${start.startNumber ?? '—'} · ${start.vehicle ?? ''}`,
        `Status: ${status.acceptance ?? '—'} / ${status.registration ?? '—'}`,
        `Zahlung: ${payment.status ?? '—'} · offen ${formatMoney(Number(payment.amountOpenCents ?? 0))}`
      ].join('\n');
    }).join('\n\n');
  }
  return JSON.stringify(value, null, 2);
};
