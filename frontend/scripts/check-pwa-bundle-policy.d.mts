export interface PwaBundleViolation {
  artifact: string
  message: string
}

export function inspectPwaBundle(directory: string): PwaBundleViolation[]
export function assertPwaBundlePolicy(directory: string): void
