export function byPriority(items) {
  return items.slice().sort((a, b) => b.priority - a.priority);
}
