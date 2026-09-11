export function loadConfig(env = process.env) {
  return {
    port: env.PORT !== undefined && env.PORT !== '' ? Number(env.PORT) : 3000,
    host: env.HOST !== undefined && env.HOST !== '' ? env.HOST : 'localhost',
    debug: ['true', '1'].includes(String(env.DEBUG ?? '').toLowerCase()),
  };
}
