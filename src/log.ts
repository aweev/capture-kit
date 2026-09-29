import process from "node:process"
import { inspect } from "node:util"

/**
 * Structured logging (PRD section 7, Observability).
 *
 * One call writes two places: a human line to the console sink, and a JSONL
 * record to the file sink (`logs/run.log.json`). The file always gets every
 * level so a quiet run still leaves a full trace; the console is filtered by
 * threshold. stdout is left alone so `capturekit run --json | jq` works (FR-39).
 */
export type LogLevel = "debug" | "info" | "warn" | "error"
export type LogRecord = { ts: string; level: LogLevel; msg: string; fields?: Record<string, unknown> }

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const TAG: Record<LogLevel, string> = { debug: "  ", info: "  ", warn: " !", error: " X" }

type Sinks = { console: (line: string) => void; file: (record: LogRecord) => void }

export class Logger {
  private threshold: number
  private quiet: boolean
  private sinks: Sinks

  constructor(
    opts: { level?: LogLevel; quiet?: boolean; console?: (line: string) => void; file?: (r: LogRecord) => void } = {},
  ) {
    this.threshold = RANK[opts.level ?? (process.env.CAPTUREKIT_DEBUG ? "debug" : "info")]
    this.quiet = opts.quiet ?? false
    this.sinks = {
      console: opts.console ?? ((line) => process.stderr.write(line + "\n")),
      file: opts.file ?? (() => {}),
    }
  }

  /** A copy that also writes JSONL to `file`, leaving every other setting alone. */
  withFile(file: (record: LogRecord) => void): Logger {
    const next = new Logger()
    next.threshold = this.threshold
    next.quiet = this.quiet
    next.sinks = { console: this.sinks.console, file }
    return next
  }

  emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    this.sinks.file({ ts: new Date().toISOString(), level, msg, ...(fields ? { fields } : {}) })
    if (RANK[level] < this.threshold) return
    if (this.quiet && level !== "warn" && level !== "error") return
    const detail = fields ? ` ${inspect(fields, { depth: 2, breakLength: Infinity })}` : ""
    this.sinks.console(`${TAG[level]} ${msg}${detail}`)
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.emit("debug", msg, fields)
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit("info", msg, fields)
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit("warn", msg, fields)
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.emit("error", msg, fields)
  }
}

/** Errors we raise ourselves are reported as a sentence + a hint, not a stack. */
export function describeError(err: unknown): { message: string; hint?: string } {
  if (err instanceof Error) return { message: err.message, hint: (err as { hint?: string }).hint }
  return { message: String(err) }
}
