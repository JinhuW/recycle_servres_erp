// One JSON object per line on stdout: the host's `docker logs` is the only
// place these go, and a line that parses is one a dashboard can filter.

export type Fields = Record<string, unknown>;

export interface Logger {
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

function emit(level: string, msg: string, fields: Fields | undefined, write: (line: string) => void): void {
  const line: Fields = { ts: new Date().toISOString(), level, msg };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v instanceof Error) line[k] = v.message;
      else if (v !== undefined) line[k] = v;
    }
  }
  write(JSON.stringify(line) + '\n');
}

export function createLogger(write: (line: string) => void = (l) => process.stdout.write(l)): Logger {
  return {
    info: (msg, fields) => emit('info', msg, fields, write),
    warn: (msg, fields) => emit('warn', msg, fields, write),
    error: (msg, fields) => emit('error', msg, fields, write),
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
