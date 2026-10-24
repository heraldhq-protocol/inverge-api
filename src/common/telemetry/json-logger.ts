import { LoggerService } from '@nestjs/common';

type Level = 'verbose' | 'debug' | 'log' | 'warn' | 'error' | 'fatal';

const ORDER: Record<Level, number> = {
  verbose: 0,
  debug: 1,
  log: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

const SECRET_KEY = /token|secret|password|authorization|cookie|api[-_]?key/i;
const MAX_STRING = 2_000;

function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (depth >= 3) return '[depth limit]';
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SECRET_KEY.test(key) ? '[redacted]' : sanitize(item, depth + 1);
    }
    return result;
  }
  return String(value);
}

/**
 * JSON log sink for production (architecture plan §4.6). It is installed with
 * `app.useLogger` so messages from Nest internals and feature services share one
 * shape. Objects are flattened into the line; secret-shaped keys are redacted at
 * any depth and long strings are truncated.
 */
export class JsonLogger implements LoggerService {
  constructor(private readonly minLevel: Level = 'log') {}

  log(message: unknown, context?: string): void {
    this.write('log', message, context);
  }

  error(message: unknown, stack?: string, context?: string): void {
    this.write('error', message, context, stack);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('verbose', message, context);
  }

  fatal(message: unknown, context?: string): void {
    this.write('fatal', message, context);
  }

  private write(
    level: Level,
    message: unknown,
    context?: string,
    stack?: string,
  ): void {
    if (ORDER[level] < ORDER[this.minLevel]) return;

    const base: Record<string, unknown> =
      message !== null && typeof message === 'object' && !(message instanceof Error)
        ? (sanitize(message) as Record<string, unknown>)
        : { message: sanitize(message) };

    const entry = {
      ...base,
      time: new Date().toISOString(),
      level: level === 'log' ? 'info' : level,
      ...(context ? { context } : {}),
      ...(stack ? { stack } : {}),
    };

    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
}
