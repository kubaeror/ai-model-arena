import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const targetDir = resolve(__dirname, '..', 'src', 'dashboard-client', 'src');

// Map from old px-based spacing values to Tailwind v4 rem-based equivalents
const remap: Record<string, string> = {
  '4':  '1',
  '8':  '2',
  '12': '3',
  '16': '4',
  '24': '6',
  '32': '8',
  '48': '12',
  '64': '16',
};

// Spacing utility prefixes — these use the spacing theme key
const spacingPrefixes = [
  'p', 'px', 'py', 'pt', 'pr', 'pb', 'pl',
  'm', 'mx', 'my', 'mt', 'mr', 'mb', 'ml',
  'gap', 'gap-x', 'gap-y',
  'h', 'w', 'min-h', 'min-w', 'max-h', 'max-w',
  'top', 'right', 'bottom', 'left', 'inset',
  'space-x', 'space-y',
  'translate-x', 'translate-y',
  'scroll-m', 'scroll-mx', 'scroll-my', 'scroll-mt', 'scroll-mr', 'scroll-mb', 'scroll-ml',
  'scroll-p', 'scroll-px', 'scroll-py', 'scroll-pt', 'scroll-pr', 'scroll-pb', 'scroll-pl',
  'indent',
].join('|');

const values = Object.keys(remap).join('|');

// Match: word-boundary, optional `!` important modifier, spacing prefix, `-`, value, word-boundary
const regex = new RegExp(`\\b(!?)(${spacingPrefixes})-(${values})\\b`, 'g');

function walkDir(dir: string, files: string[]) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.tsx')) {
      files.push(fullPath);
    }
  }
}

function processFile(filePath: string): boolean {
  const content = readFileSync(filePath, 'utf-8');
  let changed = false;

  const result = content.replace(regex, (match, important, prefix, value) => {
    const newValue = remap[value];
    if (!newValue) return match;
    changed = true;
    return `${important}${prefix}-${newValue}`;
  });

  if (changed) {
    writeFileSync(filePath, result, 'utf-8');
  }
  return changed;
}

const files: string[] = [];
walkDir(targetDir, files);

console.log(`\nFound ${files.length} .tsx files.`);
console.log('Remapping spacing classes...\n');

let changedCount = 0;
let unchangedCount = 0;
let totalReplacements = 0;

for (const file of files) {
  const content = readFileSync(file, 'utf-8');
  const matches = content.match(regex);
  if (matches) totalReplacements += matches.length;

  if (processFile(file)) {
    changedCount++;
    const relPath = file.substring(targetDir.length);
    console.log(`  ✓ ${relPath} (${matches?.length ?? 0})`);
  } else {
    unchangedCount++;
  }
}

console.log(`\nDone: ${changedCount} files changed, ${unchangedCount} files unchanged, ~${totalReplacements} replacements.\n`);
