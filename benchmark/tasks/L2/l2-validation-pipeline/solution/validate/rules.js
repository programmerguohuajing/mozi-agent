export function required() {
  return (value) => (value === undefined || value === null || value === '' ? '必填' : null);
}

export function string({ min, max } = {}) {
  return (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') return '需为字符串';
    if (min !== undefined && value.length < min) return `长度不得小于 ${min}`;
    if (max !== undefined && value.length > max) return `长度不得大于 ${max}`;
    return null;
  };
}

export function email() {
  return (value) => {
    if (value === undefined || value === null || value === '') return null;
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? null : 'email 非法';
  };
}

export function min(n) {
  return (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || Number.isNaN(value)) return '需为数字';
    return value >= n ? null : `不得小于 ${n}`;
  };
}
