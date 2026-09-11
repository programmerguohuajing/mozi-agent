export function normalizeName(name) {
  return String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}
