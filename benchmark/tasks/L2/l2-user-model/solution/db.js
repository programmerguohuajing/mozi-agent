import { toSafe } from './models/user.js';
import { UserRepository } from './repo/user-repo.js';

const repo = new UserRepository();

export function registerUser(input) {
  return toSafe(repo.create(input));
}

export { repo };
