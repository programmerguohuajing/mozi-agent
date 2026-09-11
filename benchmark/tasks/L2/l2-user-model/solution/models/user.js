export function createUser(input) {
  if (!input?.name || !input?.email) {
    throw new Error('name 与 email 必填');
  }
  return {
    name: input.name,
    email: input.email,
    role: input.role ?? 'member',
    password: input.password,
  };
}

export function toSafe(user) {
  const { password: _password, ...safe } = user;
  return safe;
}
