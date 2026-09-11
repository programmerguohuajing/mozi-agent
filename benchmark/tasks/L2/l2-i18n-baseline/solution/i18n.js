import zh from './locales/zh.js';
import en from './locales/en.js';

const catalogs = { zh, en };

function interpolate(template, params) {
  return String(template).replace(/\{(\w+)\}/g, (m, key) => (key in params ? String(params[key]) : m));
}

export function t(key, lang = 'zh', params = {}) {
  const catalog = catalogs[lang] ?? catalogs.zh;
  const template = catalog[key] ?? catalogs.zh[key] ?? key;
  return interpolate(template, params);
}
