export function validate(obj, schema) {
  const errors = [];
  for (const [field, rules] of Object.entries(schema)) {
    const value = obj?.[field];
    for (const rule of rules) {
      const message = rule(value);
      if (message) {
        errors.push({ field, message });
        break;
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
