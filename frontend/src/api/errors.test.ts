import { describe, expect, it } from 'vitest'
import { AxiosError, AxiosHeaders } from 'axios'
import { parseApiError } from './errors'

function makeAxiosError(status: number, data: unknown): AxiosError {
  const err = new AxiosError(
    `Request failed with status code ${status}`,
    String(status),
    undefined,
    {},
    {
      status,
      data,
      statusText: '',
      headers: new AxiosHeaders(),
      config: { headers: new AxiosHeaders() },
    },
  )
  return err
}

function makeNetworkError(): AxiosError {
  // No response object — mirrors what axios emits when the server is unreachable.
  return new AxiosError('Network Error', 'ERR_NETWORK')
}

describe('parseApiError', () => {
  it('returns a generic message for unknown (non-axios) shapes', () => {
    const result = parseApiError(new Error('boom'))
    expect(result.topMessage).toBe('Something went wrong. Please try again.')
    expect(result.fieldErrors).toEqual({})
  })

  it('returns a connection-failed message for network errors', () => {
    const result = parseApiError(makeNetworkError())
    expect(result.topMessage).toMatch(/Couldn't reach the server/)
    expect(result.fieldErrors).toEqual({})
  })

  it('maps invalid_credentials (401) to a banner with no field errors', () => {
    const result = parseApiError(
      makeAxiosError(401, { error: 'invalid_credentials' }),
    )
    expect(result.topMessage).toBe('Email or password is incorrect.')
    expect(result.fieldErrors).toEqual({})
  })

  it('maps reauthentication_failed (403) to a password-specific banner', () => {
    const result = parseApiError(
      makeAxiosError(403, { error: 'reauthentication_failed' }),
    )
    expect(result.topMessage).toBe('The password you entered is incorrect.')
    expect(result.code).toBe('reauthentication_failed')
  })

  it('maps email_taken (409) to a field error on email with no banner', () => {
    const result = parseApiError(makeAxiosError(409, { error: 'email_taken' }))
    expect(result.topMessage).toBeNull()
    expect(result.fieldErrors.email).toMatch(/already exists/i)
  })

  it('maps edit_conflict (409) to a reload-and-reapply message', () => {
    const result = parseApiError(makeAxiosError(409, { error: 'edit_conflict' }))
    expect(result.topMessage).toMatch(/changed elsewhere/i)
    expect(result.code).toBe('edit_conflict')
  })

  it('maps rate_limited (429) to a banner', () => {
    const result = parseApiError(
      makeAxiosError(429, { error: 'rate_limited' }),
    )
    expect(result.topMessage).toMatch(/Too many attempts/)
  })

  it('maps forbidden (403) to a blocked-request banner', () => {
    const result = parseApiError(makeAxiosError(403, { error: 'forbidden' }))
    expect(result.topMessage).toMatch(/server blocked/i)
    expect(result.fieldErrors).toEqual({})
  })

  it('maps non-json 403 responses to a blocked-request banner', () => {
    const result = parseApiError(makeAxiosError(403, 'Invalid CORS request'))
    expect(result.topMessage).toMatch(/server blocked/i)
    expect(result.fieldErrors).toEqual({})
  })

  it('maps validation_failed (400) with backend list-shape fieldErrors', () => {
    const result = parseApiError(
      makeAxiosError(400, {
        error: 'validation_failed',
        message: 'One or more fields failed validation.',
        fieldErrors: [
          { field: 'email', message: 'must be a well-formed email address' },
          { field: 'password', message: 'size must be between 12 and 128' },
        ],
      }),
    )
    expect(result.topMessage).toMatch(/highlighted fields/)
    expect(result.fieldErrors.email).toMatch(/email/i)
    expect(result.fieldErrors.password).toMatch(/12/)
  })

  it('also accepts map-shape fieldErrors (defensive forward-compat)', () => {
    const result = parseApiError(
      makeAxiosError(400, {
        error: 'validation_failed',
        fieldErrors: { displayName: 'must not be blank' },
      }),
    )
    expect(result.fieldErrors.displayName).toBe('must not be blank')
  })

  it('maps invalid_display_name (400) to a displayName field error', () => {
    const result = parseApiError(
      makeAxiosError(400, { error: 'invalid_display_name' }),
    )
    expect(result.fieldErrors.displayName).toMatch(/different display name/i)
  })

  it('falls back to a generic message for unknown 4xx codes', () => {
    const result = parseApiError(makeAxiosError(418, { error: 'teapot' }))
    expect(result.topMessage).toBe('Something went wrong. Please try again.')
  })

  it('uses a server-error banner for 5xx', () => {
    const result = parseApiError(makeAxiosError(500, {}))
    expect(result.topMessage).toMatch(/server ran into a problem/i)
  })

  it('marks network errors as warning severity', () => {
    const result = parseApiError(makeNetworkError())
    expect(result.severity).toBe('warning')
  })

  it('marks 401 invalid_credentials as error severity', () => {
    const result = parseApiError(
      makeAxiosError(401, { error: 'invalid_credentials' }),
    )
    expect(result.severity).toBe('error')
  })

  it('marks 5xx as error severity', () => {
    const result = parseApiError(makeAxiosError(500, {}))
    expect(result.severity).toBe('error')
  })

  it('marks unknown (non-axios) shapes as error severity', () => {
    const result = parseApiError(new Error('boom'))
    expect(result.severity).toBe('error')
  })
})
