const store = new Map();

export function save(key, value) {
  store.set(key, value);
  return true;
}

export function load(key) {
  return store.get(key);
}
