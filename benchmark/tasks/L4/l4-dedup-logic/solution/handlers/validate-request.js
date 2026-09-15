export function nonEmptyString(message) {
  return (value) => (typeof value === 'string' && value.trim() !== '' ? null : message);
}

export function validateRequest(body, schema) {
  const errors = [];
  for (const [field, rule] of Object.entries(schema)) {
    const message = rule(body?.[field]);
    if (message) errors.push({ field, message });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}
