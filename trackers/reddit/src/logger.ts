// Minimal leveled logger. Every line is tagged with the worker id so a
// combined log stream from 10 VMs stays attributable.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {debug: 10, info: 20, warn: 30, error: 40};

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /**
   * Emits a machine-readable event as one pure-JSON line (no text prefix), so
   * a log shipper can parse it into fields and OpenSearch can filter on them
   * (`event: post_evaluated AND verdict: target`). Always emitted regardless
   * of log level: events are data, not diagnostics.
   */
  event(name: string, fields: Record<string, unknown>): void;
  child(scope: string): Logger;
}

function isLevel(value: string): value is LogLevel {
  return value in LEVEL_ORDER;
}

export function createLogger(workerId: string, level: string, scope?: string): Logger {
  const minimum = LEVEL_ORDER[isLevel(level) ? level : 'info'];

  const emit = (lineLevel: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[lineLevel] < minimum) return;
    const parts = [
      new Date().toISOString(),
      lineLevel.toUpperCase().padEnd(5),
      `[${workerId}]`,
    ];
    if (scope) parts.push(`(${scope})`);
    parts.push(message);
    if (fields && Object.keys(fields).length > 0) parts.push(JSON.stringify(fields));
    const line = parts.join(' ');
    if (lineLevel === 'error') console.error(line);
    else if (lineLevel === 'warn') console.warn(line);
    else console.log(line);
  };

  const emitEvent = (name: string, fields: Record<string, unknown>): void => {
    // Stable key order: identity first, then the payload. One line, no prefix.
    console.log(JSON.stringify({
      time: new Date().toISOString(),
      worker: workerId,
      event: name,
      ...fields,
    }));
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    event: emitEvent,
    child: (childScope) => createLogger(workerId, level, scope ? `${scope}:${childScope}` : childScope),
  };
}
