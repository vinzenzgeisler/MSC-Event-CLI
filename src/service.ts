import { MscEventApi } from './api.js';
import { exactMatch, groupByDriver, type SearchSpec } from './lookup.js';
import { ambiguousCandidate, compactEntry } from './project.js';
import type { EntryListItem } from './schemas.js';

export class SupportService {
  constructor(private readonly api: MscEventApi) {}

  health() {
    return this.api.health();
  }

  async detail(entryId: string, full = false) {
    const response = await this.api.entryDetail(entryId);
    return full
      ? { status: 'matched' as const, mode: 'full' as const, entry: response.entry, history: response.history }
      : { status: 'matched' as const, mode: 'compact' as const, entry: compactEntry(response) };
  }

  async lookup(spec: SearchSpec, full = false) {
    const current = await this.api.currentEvent();
    const listedEntries: EntryListItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.api.searchEntries(current.event.id, spec.value, cursor);
      listedEntries.push(...result.entries);
      const next = result.meta.hasMore ? result.meta.nextCursor ?? undefined : undefined;
      if (!next) break;
      cursor = next;
    }
    const exact = listedEntries.filter((entry) => exactMatch(entry, spec));
    const groups = groupByDriver(exact);
    if (groups.length === 0) {
      return { status: 'not_found' as const, query: spec, event: current.event };
    }
    if (groups.length > 1) {
      return {
        status: 'ambiguous' as const,
        query: spec,
        event: current.event,
        candidates: groups.map((group) => ({
          ...ambiguousCandidate(group.entries[0]!),
          entryIds: group.entries.map((entry) => entry.id)
        }))
      };
    }
    const group = groups[0]!;
    const detailedEntries = [];
    for (const item of group.entries) {
      const response = await this.api.entryDetail(item.id);
      detailedEntries.push(full ? { entry: response.entry, history: response.history } : compactEntry(response));
    }
    return {
      status: 'matched' as const,
      mode: full ? 'full' as const : 'compact' as const,
      query: spec,
      event: current.event,
      driver: ambiguousCandidate(group.entries[0]!),
      entries: detailedEntries
    };
  }
}
