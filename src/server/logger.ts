/**
 * Logging.
 *
 * Everything goes to stderr. On the stdio transport, stdout carries the MCP
 * protocol itself, so a stray `console.log` there corrupts the stream and
 * presents as an unexplained client disconnect.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

export function createLogger(level: LogLevel = "info"): Logger {
    const threshold = ORDER[level] ?? ORDER.info;
    const emit = (at: LogLevel, message: string) => {
        if (ORDER[at] < threshold) return;
        process.stderr.write(`${new Date().toISOString()} ${at.padEnd(5)} ${message}\n`);
    };

    return {
        debug: (message) => emit("debug", message),
        info: (message) => emit("info", message),
        warn: (message) => emit("warn", message),
        error: (message) => emit("error", message),
    };
}
