/**
 * Guards against a TSL typo becoming a blank screen.
 *
 * Names destructured from the TSL namespace are plain property reads: a
 * misspelling yields `undefined` and fails only when a frame is drawn, with a
 * stack that points into the compiled shader graph rather than at the typo.
 * This checks them against the real module instead.
 *
 *   npm run check
 */
import * as TSL from 'three/tsl';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.join(import.meta.dirname, '..', 'src');

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
}

let missingTotal = 0;
let checked = 0;

for (const file of walk(SRC)) {
  const src = readFileSync(file, 'utf8');
  // `const { a, b } = TSL;` — the only way this codebase pulls TSL names in
  const block = src.match(/const\s*\{([\s\S]*?)\}\s*=\s*TSL\s*;/);
  if (!block) continue;

  const names = block[1].split(',').map(s => s.trim()).filter(Boolean);
  const missing = names.filter(n => TSL[n] === undefined);
  checked++;

  const rel = path.relative(path.join(SRC, '..'), file);
  if (missing.length) {
    console.error(`  ✗ ${rel}: ${missing.join(', ')}`);
    missingTotal += missing.length;
  } else {
    console.log(`  ✓ ${rel} (${names.length})`);
  }
}

console.log(`\n${checked}개 파일 검사, 누락 ${missingTotal}개`);
process.exit(missingTotal ? 1 : 0);
