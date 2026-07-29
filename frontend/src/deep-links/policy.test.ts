import { describe, expect, it } from 'vitest'
import { parseDeepLink } from './policy'

describe('parseDeepLink', () => {
  it('accepts only the documented universal-link routes', () => {
    expect(parseDeepLink('https://dupert.vercel.app/share/invite_123')).toEqual({ kind: 'share', token: 'invite_123' })
    expect(parseDeepLink('https://dupert.vercel.app/share/invite_123/guest')).toEqual({ kind: 'share-guest', token: 'invite_123' })
    expect(parseDeepLink('https://dupert.vercel.app/verify-email?token=verify_123&return=%2Ftrips')).toEqual({
      kind: 'verify-email', token: 'verify_123', returnTo: { kind: 'route', path: '/trips' },
    })
    expect(parseDeepLink('https://dupert.vercel.app/verify-email?token=verify_123&return=%2Fshare%2Finvite_123')).toEqual({
      kind: 'verify-email', token: 'verify_123', returnTo: { kind: 'share', token: 'invite_123' },
    })
    expect(parseDeepLink('https://dupert.vercel.app/reset-password?code=reset_123')).toEqual({ kind: 'reset-password', token: 'reset_123' })
    expect(parseDeepLink('https://dupert.vercel.app/trips/abc123/d/2026-07-29')).toEqual({ kind: 'trip', publicId: 'abc123', day: '2026-07-29' })
  })

  it.each([
    'http://dupert.vercel.app/share/token',
    'https://dupert.vercel.app:443/share/token',
    'https://user@dupert.vercel.app/share/token',
    'https://dupert.vercel.app/share/token#fragment',
    'https://dupert.vercel.app/share/token#',
    ' https://dupert.vercel.app/share/token',
    'https://dupert.vercel.app/share/token ',
    'https://dupert.vercel.app/share/token?',
    'https://dupert.vercel.app/share/token?x=1',
    'https://dupert.vercel.app/share/%2Ftoken',
    'https://dupert.vercel.app/%2e/share/token',
    'https://dupert.vercel.app/%2E%2e/share/token',
    'https://dupert.vercel.app/share/%2e%2e/token',
    'https://dupert.vercel.app/share\\token',
    'https://dupert.vercel.app/trips/UPPER',
    'https://dupert.vercel.app/trips/abc/d/2026-02-30',
    'https://dupert.vercel.app/verify-email?token=a&token=b',
    'https://dupert.vercel.app/reset-password?token=a&code=b',
  ])('rejects %s', (url) => {
    expect(parseDeepLink(url)).toBeNull()
  })
})
