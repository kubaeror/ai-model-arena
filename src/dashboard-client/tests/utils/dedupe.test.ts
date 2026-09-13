import { describe, it, expect } from 'vitest';
import { dedupeById } from '../../src/lib/dedupe.js';

describe('dedupeById', () => {
  it('keeps the first occurrence of each id and preserves order', () => {
    const rows = [
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
      { id: 'a', value: 3 },
      { id: 'c', value: 4 },
    ];
    expect(dedupeById(rows)).toEqual([
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
      { id: 'c', value: 4 },
    ]);
  });

  it('supports numeric ids', () => {
    const rows = [{ id: 2 }, { id: 1 }, { id: 2 }];
    expect(dedupeById(rows).map((r) => r.id)).toEqual([2, 1]);
  });

  it('passes through untyped transcript rows keyed by id', () => {
    const rows: Array<Record<string, unknown>> = [{ id: 'm1' }, { id: 'm1' }, { id: 'm2' }];
    expect(dedupeById(rows).map((r) => r.id)).toEqual(['m1', 'm2']);
  });

  it('returns an empty list for an empty input', () => {
    expect(dedupeById([])).toEqual([]);
  });
});
