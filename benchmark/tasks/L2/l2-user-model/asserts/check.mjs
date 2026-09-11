// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];

// 模型层
const { createUser, toSafe } = await import(pathToFileURL(join(dir, 'models/user.js')));
assert.throws(() => createUser({}), /必填/, '缺字段抛错');
const u = createUser({ name: 'alice', email: 'a@b.co', password: 'secret' });
assert.equal(u.role, 'member', 'role 默认 member');
assert.equal(u.password, 'secret', '完整模型含 password');
const safe = toSafe(u);
assert.equal('password' in safe, false, 'toSafe 去除 password');
assert.equal(safe.name, 'alice');
assert.equal('password' in u, true, 'toSafe 不修改原对象');

// 仓储层
const { UserRepository } = await import(pathToFileURL(join(dir, 'repo/user-repo.js')));
const r = new UserRepository();
const u1 = r.create({ name: 'a', email: 'a@a.co' });
const u2 = r.create({ name: 'b', email: 'b@b.co' });
assert.equal(u1.id, 1, '自增 id');
assert.equal(u2.id, 2);
assert.equal(r.list().length, 2);
assert.deepEqual(r.findById(1), { id: 1, name: 'a', email: 'a@a.co', role: 'member' }, 'findById 返回安全视图');
assert.equal(r.findById(99), null);
r.clear();
assert.equal(r.list().length, 0, 'clear 后为空');
const u3 = r.create({ name: 'c', email: 'c@c.co' });
assert.equal(u3.id, 1, 'clear 后 id 重置');

// db.js 门面
const db = await import(pathToFileURL(join(dir, 'db.js')));
const reg = db.registerUser({ name: 'alice', email: 'a@b.co', password: 'p' });
assert.equal('password' in reg, false, '对外返回安全视图');

console.log('l2-user-model: OK');
