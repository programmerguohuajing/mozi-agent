const handlers = {
  card: (amount) => {
    const fee = amount * 0.03;
    if (fee < 0.3) {
      return { ok: true, method: 'card', amount, fee: 0.3, total: amount + 0.3 };
    }
    return {
      ok: true,
      method: 'card',
      amount,
      fee: Number(fee.toFixed(2)),
      total: Number((amount + fee).toFixed(2)),
    };
  },
  wallet: (amount) => ({ ok: true, method: 'wallet', amount, fee: 0, total: amount }),
  bank: (amount) => {
    if (amount < 100) {
      return { ok: false, reason: 'bank_requires_min_100' };
    }
    return { ok: true, method: 'bank', amount, fee: 1, total: amount + 1 };
  },
};

export function processPayment({ method, amount }) {
  const handler = handlers[method];
  if (!handler) return { ok: false, reason: 'unsupported_method' };
  return handler(amount);
}

export { handlers };
