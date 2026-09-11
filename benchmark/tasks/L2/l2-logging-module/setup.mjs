// 初始化评测仓库：node setup.mjs <workspace>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');

writeFileSync(
  join(dir, 'service-a.js'),
  `export function reserveSeat(seat) {
  console.log('reserving seat ' + seat);
  if (seat < 1) {
    console.error('invalid seat: ' + seat);
    return false;
  }
  return true;
}
`,
);

writeFileSync(
  join(dir, 'service-b.js'),
  `export function refundSeat(seat) {
  console.log('refunding seat ' + seat);
  if (seat < 1) {
    console.error('invalid seat: ' + seat);
    return false;
  }
  return true;
}
`,
);
