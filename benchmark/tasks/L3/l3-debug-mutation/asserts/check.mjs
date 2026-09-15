// 断言：node check.mjs <workspace>
import { spawnSync } from 'node:child_process';

const dir = process.argv[2];
const res = spawnSync(process.execPath, ['--test'], {
  cwd: dir,
  encoding: 'utf8',
  timeout: 60_000,
});
const out = res.stdout + res.stderr;

if (res.status !== 0) {
  console.error(out.slice(0, 3000));
  console.error('l3-debug-mutation: FAIL（测试未全绿）');
  process.exit(1);
}
console.log('l3-debug-mutation: OK');
