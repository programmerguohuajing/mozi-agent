export function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
