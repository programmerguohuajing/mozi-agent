export function extractBold(text) {
  const matches = text.match(/<b>(.*?)<\/b>/g) ?? [];
  return matches.map((m) => m.replace(/<\/?b>/g, ''));
}
