import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsvRow } from '../../src/cli.js';

// Minimal RFC-4180 parser: state machine over a single CSV line.
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

test('toCsvRow quotes fields containing commas, quotes, and newlines', () => {
  assert.equal(
    toCsvRow(['a,b', 'say "hi"', 'line1\nline2', 'plain']),
    '"a,b","say ""hi""","line1\nline2",plain',
  );
});

test('toCsvRow leaves plain fields unquoted', () => {
  assert.equal(toCsvRow(['plain', '123', 'true']), 'plain,123,true');
});

test('toCsvRow round-trips through a minimal RFC-4180 parser', () => {
  const input = ['a,b', 'say "hi"', 'line1\nline2', 'plain', '', '  spaced  '];
  assert.deepEqual(parseCsvLine(toCsvRow(input)), input);
});

test('toCsvRow handles an empty values array', () => {
  assert.equal(toCsvRow([]), '');
});
