const users = {
  u1: { id: 'u1', name: 'alice', role: 'admin' },
  u2: { id: 'u2', name: 'bob', role: 'member' },
};

async function fetchUser(userId) {
  await new Promise((r) => setTimeout(r, 5));
  return users[userId] ?? null;
}

export async function loadProfile(userId) {
  const user = await fetchUser(userId);
  if (!user) return null;
  return { name: user.name, role: user.role };
}
