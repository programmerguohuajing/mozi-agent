import { t } from './i18n.js';

export function greeting(name, lang = 'zh') {
  return t('greeting', lang, { name });
}

export function farewell(lang = 'zh') {
  return t('farewell', lang);
}
