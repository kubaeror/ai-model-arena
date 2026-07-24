/**
 * Minimal glob-to-regex conversion for the `glob` tool.
 * Handles the common cases models use: *, **, ?, [abc], {a,b}.
 * Node 20.11 doesn't have fs.globSync, so we do it manually.
 */
export function globToRegex(pattern: string): RegExp {
  let re = '';
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // ** — match zero or more path segments
        if (pattern[i + 2] === '/') {
          re += '(?:.+/)?';
          i += 3;
          continue;
        }
        // ** at end — match everything
        re += '.*';
        i += 2;
        continue;
      }
      // * — match anything except /
      re += '[^/]*';
      i++;
      continue;
    }
    if (ch === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (ch === '[') {
      const close = pattern.indexOf(']', i);
      if (close === -1) {
        re += '\\[';
        i++;
        continue;
      }
      const inner = pattern.slice(i + 1, close);
      // Handle negation [!abc]
      if (inner.startsWith('!')) {
        re += '[^' + escapeRegexChars(inner.slice(1)) + ']';
      } else {
        re += '[' + inner + ']';
      }
      i = close + 1;
      continue;
    }
    if (ch === '{') {
      const close = pattern.indexOf('}', i);
      if (close === -1) {
        re += '\\{';
        i++;
        continue;
      }
      const inner = pattern.slice(i + 1, close);
      const parts = inner.split(',').map(p => {
        const r = globToRegex(p);
        // Strip ^ and $ anchors from nested glob→regex results
        return r.source.slice(1, -1);
      });
      re += '(?:' + parts.join('|') + ')';
      i = close + 1;
      continue;
    }
    // Escape regex metacharacters
    if ('^$.+()|\\'.includes(ch)) {
      re += '\\' + ch;
    } else if (ch === '/') {
      re += '/';
    } else {
      re += ch;
    }
    i++;
  }

  return new RegExp('^' + re + '$');
}

function escapeRegexChars(s: string): string {
  return s.replace(/[\\^$.+()|[\]{}]/g, '\\$&');
}
