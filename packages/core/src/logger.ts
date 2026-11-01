import type { Logger } from '@otw/sdk'

export const consoleLogger: Logger = {
  debug: (message, context) => console.debug(`[cms] ${message}`, context ?? ''),
  info: (message, context) => console.info(`[cms] ${message}`, context ?? ''),
  warn: (message, context) => console.warn(`[cms] ${message}`, context ?? ''),
  error: (message, context) => console.error(`[cms] ${message}`, context ?? ''),
}

export function withContext(logger: Logger, extra: Record<string, unknown>): Logger {
  return {
    debug: (message, context) => logger.debug(message, { ...extra, ...context }),
    info: (message, context) => logger.info(message, { ...extra, ...context }),
    warn: (message, context) => logger.warn(message, { ...extra, ...context }),
    error: (message, context) => logger.error(message, { ...extra, ...context }),
  }
}

export interface LogEntry {
  level: keyof Logger
  message: string
  context: Record<string, unknown> | undefined
}

export type MemoryLogger = Logger & { entries: LogEntry[] }

/** Collects log entries in memory, for tests and diagnostics. */
export function createMemoryLogger(): MemoryLogger {
  const entries: LogEntry[] = []
  const log = (level: keyof Logger) => (message: string, context?: Record<string, unknown>) => {
    entries.push({ level, message, context })
  }
  return { entries, debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') }
}
