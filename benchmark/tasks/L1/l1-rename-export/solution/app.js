import { fetchUserProfile } from './lib/data.js';

export function greet(id) {
  const p = fetchUserProfile(id);
  return p ? `hello, ${p.name}` : 'hello, stranger';
}

export function label(id) {
  const p = fetchUserProfile(id);
  return p ? `user#${p.id}` : 'user#?';
}
