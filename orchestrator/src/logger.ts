import { config } from './config.ts';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

function shouldLog(level: keyof typeof LEVELS): boolean {
  return LEVELS[level] >= LEVELS[config.logLevel];
}

export const log = {
  debug(...args: unknown[]) {
    if (shouldLog('debug')) console.log(...args);
  },
  info(...args: unknown[]) {
    if (shouldLog('info')) console.log(...args);
  },
  warn(...args: unknown[]) {
    if (shouldLog('warn')) console.warn(...args);
  },
  error(...args: unknown[]) {
    if (shouldLog('error')) console.error(...args);
  },
};
