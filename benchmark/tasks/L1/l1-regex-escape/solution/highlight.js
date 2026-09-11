function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function highlight(text, term) {
  if (!term) return text;
  const re = new RegExp(escapeRegExp(term), 'g');
  return text.replace(re, (m) => `<mark>${m}</mark>`);
}
