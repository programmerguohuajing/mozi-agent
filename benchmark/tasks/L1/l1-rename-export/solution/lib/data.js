const profiles = { 1: { id: 1, name: 'alice' }, 2: { id: 2, name: 'bob' } };

export function fetchUserProfile(id) {
  return profiles[id] ?? null;
}
