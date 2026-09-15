// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];

// 管线本体
const { validate } = await import(pathToFileURL(join(dir, 'validate/index.js')));
const { required, string, email, min } = await import(
  pathToFileURL(join(dir, 'validate/rules.js'))
);

const okResult = validate({ name: 'alice' }, { name: [required()] });
assert.equal(okResult.valid, true);
assert.deepEqual(okResult.errors, []);

const badResult = validate({}, { name: [required()] });
assert.equal(badResult.valid, false);
assert.equal(badResult.errors[0].field, 'name');

// createUser 行为
const { createUser } = await import(pathToFileURL(join(dir, 'api/createUser.js')));

const good = createUser({ name: 'alice', email: 'a@b.co', age: 30 });
assert.equal(good.ok, true, '合法输入通过');
assert.deepEqual(good.user, { name: 'alice', email: 'a@b.co', age: 30 });

const noAge = createUser({ name: 'bob', email: 'b@c.co' });
assert.equal(noAge.ok, true);
assert.equal(noAge.user.age, null, 'age 可选');

const missing = createUser({});
assert.equal(missing.ok, false);
const fields = missing.errors.map((e) => e.field).sort();
assert.ok(fields.includes('name'), '报 name 错误');
assert.ok(fields.includes('email'), '报 email 错误');

const badEmail = createUser({ name: 'alice', email: 'not-an-email' });
assert.equal(badEmail.ok, false);
assert.equal(badEmail.errors[0].field, 'email');

const badAge = createUser({ name: 'alice', email: 'a@b.co', age: -1 });
assert.equal(badAge.ok, false);
assert.equal(badAge.errors[0].field, 'age');

console.log('l2-validation-pipeline: OK');
