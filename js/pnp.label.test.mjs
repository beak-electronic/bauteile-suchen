/** Quick node test: BEAK search labels from Description / EigerPN / Altium CSV. */
import {
  parsePkpCsv,
  formatBeakFromDescription,
  resolveBeakDisplay,
  partSearchLabel,
  decodePnpBytes,
} from './pnp.js';

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

assertEq(formatBeakFromDescription('3192'), '3.192', '3192 → 3.192');
assertEq(formatBeakFromDescription('5764+2071'), '5.764 & 2.071', '5764+2071');
assertEq(formatBeakFromDescription('0000'), '', 'ignore 0000');
assertEq(formatBeakFromDescription('BEAK'), '', 'ignore BEAK');
assertEq(formatBeakFromDescription('Widerstand 10k'), '', 'text desc not BEAK');

const csv = `PartID,EigerPN,Description,Side,Rotation,X,Y,Package,Bin,Value
R368,EG-SKIP,3192,TOP,0,1.0,2.0,0805,1,0R
R366,5764+2071,0000,TOP,0,3.0,4.0,0805,1,0R/nb
R379,,BEAK,TOP,0,5.0,6.0,0805,1,"4,7K"
R1,EG-R-10K,Widerstand 10k Ohm,TOP,0,7.0,8.0,0805,1,10k
`;

const { parts, errors } = parsePkpCsv(csv);
if (errors.length) {
  console.error('parse errors', errors);
  process.exitCode = 1;
}

const byId = Object.fromEntries(parts.map((p) => [p.id, p]));

assertEq(partSearchLabel(byId.R368), 'R368 · 0R (3.192)', 'R368 Description=3192 Value=0R');
assertEq(resolveBeakDisplay(byId.R368), '3.192', 'R368 beak from Description');
assertEq(partSearchLabel(byId.R366), 'R366 · 0R/nb (5.764 & 2.071)', 'R366 BEAK from EigerPN when Description=0000');
assertEq(partSearchLabel(byId.R379), 'R379 · 4,7K', 'R379 Description=BEAK ignored');
assertEq(partSearchLabel(byId.R1), 'R1 · 10k', 'R1 text Description not used as BEAK');

// cp1252 µ (0xB5) must decode to µ, not �
const cp1252 = Uint8Array.from([0x31, 0xb5, 0x2f, 0x36, 0x33, 0x30, 0x56]); // 1µ/630V
assertEq(decodePnpBytes(cp1252), '1µ/630V', 'decodePnpBytes cp1252 µ');
const utf8 = new TextEncoder().encode('1µ/630V');
assertEq(decodePnpBytes(utf8), '1µ/630V', 'decodePnpBytes utf-8 µ');

// Altium quoted CSV: Comment=value, Description=BEAK
const altium = `Altium Designer Pick and Place Locations
========================================================================================================================

"Designator","Comment","Layer","Footprint","Center-X(mm)","Center-Y(mm)","Rotation","Description"
"C241","1µ/630V-/nb","TopLayer","EDV_5700","55.3000","60.7000","90","5700"
"C241B","330n/400V/nb","TopLayer","EDV_3396","55.3000","62.9825","90","3396"
"R368","0R","TopLayer","0805","1.0","2.0","0","3192"
`;
const { parts: ap, errors: ae } = parsePkpCsv(altium);
if (ae.length) console.warn('altium warnings', ae);
const aBy = Object.fromEntries(ap.map((p) => [p.id, p]));
assertEq(aBy.C241?.value, '1µ/630V-/nb', 'Altium C241 Comment→value');
assertEq(aBy.C241?.description, '5700', 'Altium C241 Description→BEAK raw');
assertEq(partSearchLabel(aBy.C241), 'C241 · 1µ/630V-/nb (5.700)', 'Altium C241 label');
assertEq(partSearchLabel(aBy.C241B), 'C241B · 330n/400V/nb (3.396)', 'Altium C241B label');
assertEq(partSearchLabel(aBy.R368), 'R368 · 0R (3.192)', 'Altium R368 label');

if (!process.exitCode) console.log('\nAll label tests passed.');
