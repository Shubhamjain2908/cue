import winston from "winston";

export interface CueLoggerOptions {
  /** Override process.env.LOG_LEVEL. */
  readonly level?: string;
  /** Suppress all output (for tests). */
  readonly silent?: boolean;
}

/**
 * Create a Winston logger with Cue's standard format: timestamped lines with
 * a `service` tag, JSON extra fields, and error output routed to stderr.
 */
export function createCueLogger(
  service: string,
  options?: CueLoggerOptions,
): winston.Logger {
  return winston.createLogger({
    defaultMeta: { service },
    level: options?.level ?? process.env.LOG_LEVEL ?? "info",
    silent: options?.silent ?? false,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.printf((info) => {
        const { timestamp, level, message, service: svc, ...rest } = info;
        const extra =
          Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : "";
        return `${String(timestamp)} ${String(svc ?? service)} ${level}: ${String(message)}${extra}`;
      }),
    ),
    transports: [new winston.transports.Console({ stderrLevels: ["error"] })],
  });
}

/** Convenience singleton for one-shot CLI commands (doctor, llm-smoke, etc.). */
export const cueLogger = createCueLogger("cue-cli");
