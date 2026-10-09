import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import {
  expandKundenRefs,
  parseKundenBomLayoutText,
  applyKundenValuesToParts,
  kundenBeakDigits,
} from './kundenBom.js';
import { partSearchLabel, formatBeakFromDescription } from './pnp.js';

function assertEq(got, want, msg) {
  if (got !== want) {
    console.error('FAIL:', msg);
    console.error('  got: ', JSON.stringify(got));
    console.error('  want:', JSON.stringify(want));
    process.exitCode = 1;
  } else {
    console.log('OK:', msg, '→', JSON.stringify(got));
  }
}

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else console.log('OK:', msg);
}

assertEq(expandKundenRefs('C 17').join(','), 'C17', 'spaced ref');
assertEq(expandKundenRefs('KL151-154').join(','), 'KL151,KL152,KL153,KL154', 'range');
assertEq(expandKundenRefs('R1, R2, R5').join(','), 'R1,R2,R5', 'comma list');
assertEq(expandKundenRefs('5,6,L-,L+').join(','), '5,6,L-,L+', 'mixed tokens');
assertEq(kundenBeakDigits('1.277'), '1277', 'beak digits');
assertEq(formatBeakFromDescription('1277'), '1.277', 'format 1277');

const layout = execSync(
  'pdftotext -layout /workspace/test-assets/werte-ersatz-stueckliste.pdf -',
  { encoding: 'utf8' },
);
const parsed = parseKundenBomLayoutText(layout);
console.log('parsed entries', parsed.entries.length, 'unique refs', parsed.byRef.size, 'title', parsed.title, 'edv', parsed.edv);
assert(parsed.entries.length >= 100, `expected >=100 rows, got ${parsed.entries.length}`);
assert(parsed.byRef.has('C1'), 'has C1');
assert(parsed.byRef.has('R2'), 'has R2');
assert(parsed.byRef.has('KL151'), 'range expanded KL151');
assert(parsed.byRef.has('KL154'), 'range expanded KL154');
const c1 = parsed.byRef.get('C1');
assertEq(c1.value, '100 nF / 100 V / X7R / RM 5,0', 'C1 value');
assertEq(c1.beak, '1.218', 'C1 beak');
const r2 = parsed.byRef.get('R2');
assertEq(r2.value, '10 K / 1% / 0,6 W', 'R2 value');
assertEq(r2.beak, '1.184', 'R2 beak');
const kl = parsed.byRef.get('KL151');
assertEq(kl.value, 'Printklemme 4 pol WAGO', 'KL151 value');

const parts = [
  { id: 'C1', value: 'PLACEHOLDER', description: '0000', beakNr: '' },
  { id: 'R2', value: 'PLACEHOLDER', description: '0000', beakNr: '' },
  { id: 'KL152', value: 'PLACEHOLDER', description: '0000', beakNr: '' },
  { id: 'R999', value: 'UNMATCHED', description: '0000', beakNr: '' },
];
const { replaced, total } = applyKundenValuesToParts(parts, parsed.byRef);
assertEq(replaced, 3, 'replaced count');
assertEq(total, 4, 'total');
assertEq(parts[0].value, '100 nF / 100 V / X7R / RM 5,0', 'C1 applied value');
assertEq(partSearchLabel(parts[0]), 'C1 · 100 nF / 100 V / X7R / RM 5,0 (1.218)', 'C1 label');
assertEq(parts[3].value, 'n.b.', 'unmatched → n.b.');
assertEq(parts[3].description, '', 'unmatched no BEAK desc');
assertEq(partSearchLabel(parts[3]), 'R999 · n.b.', 'unmatched label');

// examples
const examples = ['C1', 'R2', 'R5', 'IC1', 'U5', 'KL151', '5'];
for (const id of examples) {
  const e = parsed.byRef.get(id);
  if (e) console.log(`EX ${id} → ${e.value} (${e.beak})`);
  else console.log(`EX ${id} → (missing)`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log('ALL OK', 'rows', parsed.entries.length, 'refs', parsed.byRef.size);
