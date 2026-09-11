import { createUser, toSafe } from '../models/user.js';

export class UserRepository {
  #users = [];
  #nextId = 1;

  create(input) {
    const user = { id: this.#nextId++, ...createUser(input) };
    this.#users.push(user);
    return user;
  }

  findById(id) {
    const user = this.#users.find((u) => u.id === id);
    return user ? toSafe(user) : null;
  }

  list() {
    return this.#users.map(toSafe);
  }

  clear() {
    this.#users = [];
    this.#nextId = 1;
  }
}
