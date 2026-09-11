const users = {
  u1: { id: 'u1', name: 'alice' },
  u2: { id: 'u2', name: 'bob' },
};

export const stats = { queries: 0 };

export async function fetchUser(id) {
  stats.queries += 1;
  await new Promise((r) => setTimeout(r, 5));
  return users[id] ?? null;
}
