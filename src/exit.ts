/**
 * Exit codes (FR-39: "exit codes and JSON output for scripting").
 *
 * The contract with CI is deliberately boring:
 *   0 = run succeeded (possibly with individual capture failures under the threshold)
 *   1 = run exceeded the failure threshold
 *   2 = the command line was wrong
 *   3 = the config file was wrong
 *   4 = the environment cannot run a capture (no Node, no browser)
 * 130 = interrupted (Ctrl-C / SIGINT)
 */
export const ExitCode = {
  Ok: 0,
  CaptureFailed: 1,
  Usage: 2,
  Config: 3,
  Environment: 4,
  Interrupted: 130,
} as const

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode]

/**
 * Every user-facing failure is one of these, so the CLI top level can print a
 * sentence plus a hint and still return a meaningful code. Principle 2: never
 * fail silently.
 */
export class CaptureKitError extends Error {
  code: ExitCodeValue
  hint: string | undefined

  constructor(message: string, code: ExitCodeValue, hint?: string) {
    super(message)
    this.name = "CaptureKitError"
    this.code = code
    this.hint = hint
  }
}

/** Type guard used by run/init/doctor to bail with a code. */
export function isCaptureKitError(err: unknown): err is CaptureKitError {
  return err instanceof CaptureKitError
}
