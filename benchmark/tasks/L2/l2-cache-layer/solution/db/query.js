import { TTLCache } from '../cache/cache.js';
import { fetchUser as backendFetchUser, stats } from './_backend.js';

const cache = new TTLCache();
const TTL_MS = 1000;

export async function fetchUser(id) {
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  const value = await backendFetchUser(id);
  cache.set(id, value, TTL_MS);
  return value;
}

export { stats };
