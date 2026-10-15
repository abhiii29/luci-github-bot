import { redact } from "./redact.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

interface LogContext {
  jobId?: string;
  repo?: string;
  issue?: number;
  [key: string]: unknown;
}

interface LoggerOptions {
  level?: LogLevel;
  redactSecrets?: boolean;
}

const DEFAULT_OPTIONS: Required<LoggerOptions> = {
  level: "info",
  redactSecrets: true,
};

export class Logger {
  private options: Required<LoggerOptions>;

  constructor(options: LoggerOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  log(level: LogLevel, message: string, ctx: LogContext = {}): void {
    const order = LEVEL_ORDER[level];
    const minOrder = LEVEL_ORDER[this.options.level as LogLevel] ?? 1;

    if (order < minOrder) return;

    const entry: Record<string, unknown> = {
      level,
      ts: new Date().toISOString(),
      msg: message,
      ...ctx,
    };

    if (this.options.redactSecrets) {
      for (const key of Object.keys(entry)) {
        if (typeof entry[key] === "string") {
          entry[key] = redact(entry[key] as string);
        }
      }
    }

    try {
      process.stdout.write(JSON.stringify(entry) + "\n");
    } catch {
      // Fail silently if logging fails
    }
  }

  debug(msg: string, ctx?: LogContext): void {
    this.log("debug", msg, ctx);
  }

  info(msg: string, ctx?: LogContext): void {
    this.log("info", msg, ctx);
  }

  warn(msg: string, ctx?: LogContext): void {
    this.log("warn", msg, ctx);
  }

  error(msg: string, ctx?: LogContext): void {
    this.log("error", msg, ctx);
  }
}

export const logger = new Logger({
  level: (process.env.LOG_LEVEL as LogLevel) ?? "info",
});
