export function paginate(list, page = 1, size = 10) {
  const start = (page - 1) * size;
  const end = start + size;
  const data = list.slice(start, end);
  return {
    data,
    page,
    size,
    total: list.length,
    pageCount: Math.ceil(list.length / size),
  };
}
