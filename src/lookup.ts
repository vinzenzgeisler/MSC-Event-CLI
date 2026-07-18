import { CliError, EXIT } from './errors.js';
import type { EntryListItem } from './schemas.js';

export type SearchKind = 'orgaCode' | 'email' | 'name' | 'startNumber';
export type SearchSpec = { kind: SearchKind; value: string };

export const parseSearchSpec = (options: {
  orgaCode?: string;
  email?: string;
  name?: string;
  startNumber?: string;
}): SearchSpec => {
  const candidates: SearchSpec[] = [
    { kind: 'orgaCode', value: options.orgaCode ?? '' },
    { kind: 'email', value: options.email ?? '' },
    { kind: 'name', value: options.name ?? '' },
    { kind: 'startNumber', value: options.startNumber ?? '' }
  ];
  const values = candidates.map((item) => ({ ...item, value: item.value.trim() })).filter((item) => item.value.length > 0);
  if (values.length !== 1) {
    throw new CliError('INVALID_LOOKUP', 'Provide exactly one lookup option.', EXIT.usage);
  }
  return values[0] as SearchSpec;
};

const normalize = (value: string | null | undefined): string => (value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('de');

export const exactMatch = (entry: EntryListItem, spec: SearchSpec): boolean => {
  const expected = normalize(spec.value);
  if (spec.kind === 'orgaCode') return normalize(entry.orgaCode) === expected;
  if (spec.kind === 'email') return normalize(entry.driverEmail) === expected;
  if (spec.kind === 'startNumber') return normalize(entry.startNumberNorm) === expected;
  return normalize(`${entry.driverFirstName ?? ''} ${entry.driverLastName ?? ''}`) === expected;
};

export type DriverGroup = { driverPersonId: string; entries: EntryListItem[] };

export const groupByDriver = (entries: EntryListItem[]): DriverGroup[] => {
  const groups = new Map<string, EntryListItem[]>();
  for (const entry of entries) {
    const bucket = groups.get(entry.driverPersonId) ?? [];
    bucket.push(entry);
    groups.set(entry.driverPersonId, bucket);
  }
  return [...groups.entries()].map(([driverPersonId, grouped]) => ({ driverPersonId, entries: grouped }));
};
