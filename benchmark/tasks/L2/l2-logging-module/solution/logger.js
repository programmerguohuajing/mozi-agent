const LEVELS = { debug: 10, info: 20, error: 30 };

let currentLevel = 'debug';

export function setLevel(level) {
  if (LEVELS[level]) currentLevel = level;
}

export function createLogger(prefix) {
  const write = (level, message) => {
    if (LEVELS[level] < LEVELS[currentLevel]) return;
    const sink = level === 'error' ? console.error : console.log;
    sink(`[${level.toUpperCase()}][${prefix}] ${message}`);
  };
  return {
    debug: (m) => write('debug', m),
    info: (m) => write('info', m),
    error: (m) => write('error', m),
  };
}
