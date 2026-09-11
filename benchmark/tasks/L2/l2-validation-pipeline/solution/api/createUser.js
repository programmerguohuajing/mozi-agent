import { validate } from '../validate/index.js';
import { email, min, required, string } from '../validate/rules.js';

const schema = {
  name: [required(), string({ min: 2, max: 20 })],
  email: [required(), email()],
  age: [min(0)],
};

export function createUser(body) {
  const result = validate(body, schema);
  if (!result.valid) {
    return { ok: false, errors: result.errors };
  }
  return { ok: true, user: { name: body.name, email: body.email, age: body.age ?? null } };
}
