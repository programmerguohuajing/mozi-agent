export function buildHandlers(n) {
  const handlers = [];
  for (let i = 0; i < n; i++) {
    handlers.push(() => i);
  }
  return handlers;
}
