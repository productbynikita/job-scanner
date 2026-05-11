/**
 * Leveled, scoped, color-coded logger.
 *
 * Usage:
 *   import { createLogger } from './logger.js';
 *   const log = createLogger('greenhouse');
 *   log.info('fetching jobs', { company: 'mollie' });
 *   log.error('fetch failed', { url, status: 500 });
 *   const t = log.timer('parse');
 *   ...
 *   t.end({ jobs: 12 });   // logs duration + extra context
 *
 * Levels (from highest verbosity to lowest):
 *   trace < debug < info < warn < error < silent
 *
 * Configure via env:
 *   LOG_LEVEL=debug          # default: info
 *   LOG_FORMAT=pretty|json   # default: pretty
 *   LOG_NO_COLOR=1           # disables colors even in TTY
 */

import kleur from 'kleur';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  silent: 99,
};

function resolveLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as LogLevel;
  if (raw in LEVEL_ORDER) return raw;
  return 'info';
}

function getActiveLevel(): number {
  return LEVEL_ORDER[resolveLevel()];
}

function getFormat(): string {
  return (process.env.LOG_FORMAT ?? 'pretty').toLowerCase();
}

// Disable colors if requested or if not in a TTY
if (process.env.LOG_NO_COLOR || !process.stdout.isTTY) {
  kleur.enabled = false;
}

type Fields = Record<string, unknown>;

const LEVEL_TAG: Record<LogLevel, (s: string) => string> = {
  trace: (s) => kleur.gray(s),
  debug: (s) => kleur.cyan(s),
  info: (s) => kleur.green(s),
  warn: (s) => kleur.yellow(s),
  error: (s) => kleur.red().bold(s),
  silent: (s) => s,
};

function formatFields(fields?: Fields): string {
  if (!fields || Object.keys(fields).length === 0) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    let val: string;
    if (v === null || v === undefined) val = '-';
    else if (typeof v === 'string') val = v;
    else if (typeof v === 'number' || typeof v === 'boolean') val = String(v);
    else if (v instanceof Error) val = v.message;
    else {
      try {
        val = JSON.stringify(v);
      } catch {
        val = '[unserializable]';
      }
    }
    // Truncate very long values for terminal readability
    if (val.length > 200) val = val.substring(0, 197) + '...';
    parts.push(`${kleur.dim(k)}=${val}`);
  }
  return ' ' + parts.join(' ');
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function emit(level: LogLevel, scope: string, message: string, fields?: Fields): void {
  if (LEVEL_ORDER[level] < getActiveLevel()) return;

  if (getFormat() === 'json') {
    const obj = {
      ts: new Date().toISOString(),
      level,
      scope,
      msg: message,
      ...(fields ?? {}),
    };
    process.stdout.write(JSON.stringify(obj) + '\n');
    return;
  }

  // Pretty format: TIMESTAMP LEVEL [scope] message field=value field=value
  const ts = kleur.dim(timestamp());
  const lvl = LEVEL_TAG[level](level.toUpperCase().padEnd(5));
  const scopeStr = kleur.magenta(`[${scope}]`);
  const fieldsStr = formatFields(fields);
  const out = `${ts} ${lvl} ${scopeStr} ${message}${fieldsStr}`;

  if (level === 'error' || level === 'warn') {
    process.stderr.write(out + '\n');
  } else {
    process.stdout.write(out + '\n');
  }
}

export interface Logger {
  trace(message: string, fields?: Fields): void;
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  /** Create a child logger with an extended scope. */
  child(subScope: string): Logger;
  /** Start a timer. Call `.end()` to log the duration. */
  timer(label: string): { end: (extra?: Fields) => number };
}

export function createLogger(scope: string): Logger {
  return {
    trace: (m, f) => emit('trace', scope, m, f),
    debug: (m, f) => emit('debug', scope, m, f),
    info: (m, f) => emit('info', scope, m, f),
    warn: (m, f) => emit('warn', scope, m, f),
    error: (m, f) => emit('error', scope, m, f),
    child: (sub) => createLogger(`${scope}:${sub}`),
    timer: (label) => {
      const startedAt = Date.now();
      emit('debug', scope, `▶ ${label} started`);
      return {
        end: (extra) => {
          const ms = Date.now() - startedAt;
          emit('debug', scope, `■ ${label} done`, { durationMs: ms, ...extra });
          return ms;
        },
      };
    },
  };
}

/** Banner helper for visually separating phases of a scan. */
export function logBanner(title: string): void {
  if (getFormat() === 'json') {
    emit('info', 'banner', title);
    return;
  }
  const line = '─'.repeat(Math.max(60, title.length + 4));
  process.stdout.write('\n' + kleur.bold().cyan(line) + '\n');
  process.stdout.write(kleur.bold().cyan(`  ${title}`) + '\n');
  process.stdout.write(kleur.bold().cyan(line) + '\n\n');
}

export function logSection(title: string): void {
  if (getFormat() === 'json') {
    emit('info', 'section', title);
    return;
  }
  process.stdout.write('\n' + kleur.bold().yellow(`▸ ${title}`) + '\n');
}
