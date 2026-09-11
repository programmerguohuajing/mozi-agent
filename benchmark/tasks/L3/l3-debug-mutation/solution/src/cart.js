export function subtotal(items) {
  const total = items.reduce((sum, item) => sum + item.price * 0.9 * item.qty, 0);
  return Number(total.toFixed(2));
}
