const pad = (n) => String(n).padStart(2, '0');

export function formatDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatMoney(cents, currency = 'CNY') {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}
