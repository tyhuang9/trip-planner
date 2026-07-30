import axios, { type AxiosError } from 'axios'

/**
 * User-facing translation of backend error responses.
 *
 * Backend contract (see `com.trip.web.ErrorResponse` and `GlobalExceptionHandler`):
 *   { error: string, message: string, correlationId: string, fieldErrors: [{field, message}]? }
 *
 * AuthController also returns flat `{ "error": "<slug>" }` bodies for some 4xx codes
 * (`invalid_credentials`, `email_taken`, `invalid_display_name`, `unauthenticated`).
 *
 * `parseApiError` normalizes both into a single shape suitable for forms:
 *   - `topMessage`  — a short banner string (or null when only field errors apply).
 *   - `fieldErrors` — keyed by field name. For codes where the backend doesn't
 *                     attach field errors but the form should still surface the
 *                     problem on a specific field (e.g. `email_taken`), we
 *                     inject one client-side.
 */
export interface ParsedApiError {
  topMessage: string | null
  fieldErrors: Record<string, string>
  code: string | null
  /**
   * Visual treatment hint. Network failures (no response) are non-fatal
   * recoverable conditions that the page should style differently from
   * an outright server-side rejection.
   */
  severity: 'error' | 'warning'
}

interface BackendErrorBody {
  error?: string
  message?: string
  fieldErrors?: unknown
}

const TOP_MESSAGE_BY_CODE: Record<string, string | null> = {
  invalid_credentials: 'Email or password is incorrect.',
  reauthentication_failed: 'The password you entered is incorrect.',
  email_unverified: 'Check your email to verify your account before signing in.',
  rate_limited: 'Too many attempts. Try again in a few minutes.',
  email_taken: null,
  signup_disabled: 'Signup is temporarily closed.',
  invalid_display_name: null,
  validation_failed: 'Please fix the highlighted fields and try again.',
  malformed_request: 'Something went wrong. Please try again.',
  unauthenticated: 'Your session expired. Please sign in again.',
  forbidden: 'The server blocked this request. Refresh the page and try again.',
  conflict: 'That action conflicts with existing data.',
  edit_conflict: 'This trip changed elsewhere. Review your edits and save again.',
  invalid_verification_token: 'This verification link is invalid or expired.',
  invalid_date_range: 'Choose a valid date range.',
}

function isAxiosError(err: unknown): err is AxiosError<BackendErrorBody> {
  return axios.isAxiosError(err)
}

export function apiErrorCode(err: unknown): string | null {
  if (!isAxiosError(err) || !err.response) {
    return null
  }
  const body = err.response.data
  if (body && typeof body === 'object' && typeof body.error === 'string') {
    return body.error
  }
  return null
}

/**
 * Best-effort coercion of the backend's `fieldErrors` payload — normally a
 * `List<{field, message}>` — into a flat `Record<string,string>`. Defensive
 * enough to also accept the `Map<string,string>` shape some callers may send.
 */
function extractFieldErrors(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw) return out
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (
        entry &&
        typeof entry === 'object' &&
        'field' in entry &&
        'message' in entry
      ) {
        const field = (entry as { field: unknown }).field
        const message = (entry as { message: unknown }).message
        if (typeof field === 'string' && typeof message === 'string' && !(field in out)) {
          out[field] = message
        }
      }
    }
    return out
  }
  if (typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') {
        out[k] = v
      }
    }
  }
  return out
}

export function parseApiError(err: unknown): ParsedApiError {
  if (!isAxiosError(err)) {
    return {
      topMessage: 'Something went wrong. Please try again.',
      fieldErrors: {},
      code: null,
      severity: 'error',
    }
  }

  // Network / no response: connection refused, DNS failure, CORS preflight blocked.
  if (!err.response) {
    return {
      topMessage:
        "Couldn't reach the server. Check your connection and try again.",
      fieldErrors: {},
      code: null,
      severity: 'warning',
    }
  }

  const status = err.response.status
  const body = err.response.data
  const code = body && typeof body === 'object' ? body.error : undefined
  const normalizedCode = typeof code === 'string' ? code : null
  const fieldErrors =
    body && typeof body === 'object' ? extractFieldErrors(body.fieldErrors) : {}

  // 429 — rate-limited at any endpoint.
  if (status === 429) {
    return {
      topMessage: 'Too many attempts. Try again in a few minutes.',
      fieldErrors: {},
      code: normalizedCode,
      severity: 'error',
    }
  }

  if (typeof code === 'string') {
    if (code === 'email_taken') {
      return {
        topMessage: null,
        fieldErrors: {
          ...fieldErrors,
          email: 'An account with this email already exists.',
        },
        code,
        severity: 'error',
      }
    }
    if (code === 'invalid_display_name') {
      return {
        topMessage: null,
        fieldErrors: {
          ...fieldErrors,
          displayName: 'Please choose a different display name.',
        },
        code,
        severity: 'error',
      }
    }
    if (code in TOP_MESSAGE_BY_CODE) {
      return {
        topMessage: TOP_MESSAGE_BY_CODE[code],
        fieldErrors,
        code,
        severity: 'error',
      }
    }
  }

  // Validation 400 with no recognised slug — still surface field errors if
  // we got any, otherwise fall back to a generic message.
  if (status === 400 && Object.keys(fieldErrors).length > 0) {
    return {
      topMessage: 'Please fix the highlighted fields and try again.',
      fieldErrors,
      code: normalizedCode,
      severity: 'error',
    }
  }

  if (status === 403) {
    return {
      topMessage: 'The server blocked this request. Refresh the page and try again.',
      fieldErrors: {},
      code: normalizedCode,
      severity: 'error',
    }
  }

  if (status >= 500) {
    return {
      topMessage: 'The server ran into a problem. Please try again.',
      fieldErrors: {},
      code: normalizedCode,
      severity: 'error',
    }
  }

  return {
    topMessage: 'Something went wrong. Please try again.',
    fieldErrors,
    code: normalizedCode,
    severity: 'error',
  }
}
