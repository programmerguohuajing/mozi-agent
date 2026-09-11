import { users } from '../store/users.js';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function normalizePage(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_PAGE;
}

function normalizeLimit(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export function listUsers({ page, limit } = {}) {
  const p = normalizePage(page);
  const l = normalizeLimit(limit);
  return {
    data: users.slice((p - 1) * l, (p - 1) * l + l),
    page: p,
    limit: l,
    total: users.length,
  };
}
