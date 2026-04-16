interface CliErrorOptions {
  hint?: string
  suggestion?: string
}

class CliError extends Error {
  hint?: string
  suggestion?: string

  constructor(message: string, opts?: CliErrorOptions) {
    super(message)
    this.name = 'CliError'
    if (opts?.hint !== undefined) this.hint = opts.hint
    if (opts?.suggestion !== undefined) this.suggestion = opts.suggestion
  }
}

export { CliError }
export type { CliErrorOptions }
