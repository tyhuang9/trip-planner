import { describe, expect, it } from 'vitest'
import {
  parseBuildProfile,
  resolveBuildProfile,
  validateBuildConfiguration,
  validateNativeBackendUrl,
} from './buildProfile'

describe('build profiles', () => {
  it.each([
    ['web-development', 'web', 'development'],
    ['web-staging', 'web', 'staging'],
    ['web-production', 'web', 'production'],
    ['native-development', 'native', 'development'],
    ['native-staging', 'native', 'staging'],
    ['native-production', 'native', 'production'],
  ] as const)('parses %s', (mode, target, environment) => {
    expect(parseBuildProfile(mode)).toMatchObject({ target, environment, mode })
  })

  it('rejects an implicit or misspelled build profile', () => {
    expect(() => parseBuildProfile('native')).toThrow(/unsupported dupert build mode/i)
  })

  it('keeps Vite and Vitest compatibility modes explicitly web-only', () => {
    expect(resolveBuildProfile('development').mode).toBe('web-development')
    expect(resolveBuildProfile('production').mode).toBe('web-production')
    expect(resolveBuildProfile('test').mode).toBe('web-development')
  })
})

describe('native backend URL validation', () => {
  const nativeDevelopment = parseBuildProfile('native-development')
  const nativeStaging = parseBuildProfile('native-staging')
  const nativeProduction = parseBuildProfile('native-production')

  it('keeps web same-origin behavior and requires an explicit native URL', () => {
    expect(validateNativeBackendUrl(undefined, parseBuildProfile('web-development'))).toBe('')
    expect(() => validateNativeBackendUrl(undefined, nativeDevelopment)).toThrow(/require vite_backend_api_url/i)
  })

  it('allows an explicit local development backend and normalizes trailing slashes', () => {
    expect(validateNativeBackendUrl('http://localhost:8000/', nativeDevelopment)).toBe('http://localhost:8000')
  })

  it.each([
    'http://api.dupert.test',
    'https://localhost:8000',
    'https://127.0.0.1:8000',
    'https://[::1]:8000',
    'https://user:password@api.dupert.test',
    'https://api.dupert.test?preview=true',
    'https://api.dupert.test#fragment',
    'https://backend.example.com',
    'https://REPLACE_WITH_BACKEND_URL',
    '/api',
  ])('rejects unsafe native staging URL %s', (url) => {
    expect(() => validateNativeBackendUrl(url, nativeStaging)).toThrow()
  })

  it('accepts a concrete HTTPS endpoint for native production', () => {
    expect(validateNativeBackendUrl('https://api.dupert.test/', nativeProduction)).toBe('https://api.dupert.test')
  })
})

describe('native production public configuration', () => {
  it('rejects browser-only Maps and app-wall configuration', () => {
    const profile = parseBuildProfile('native-production')
    const backendBaseUrl = 'https://api.dupert.test'

    expect(() => validateBuildConfiguration(profile, {
      backendBaseUrl,
      browserMapsApiKey: 'browser-key',
    })).toThrow(/google maps/i)
    expect(() => validateBuildConfiguration(profile, {
      backendBaseUrl,
      appAccessPassword: 'not-a-secret',
    })).toThrow(/app_access_password/i)
  })

  it('accepts a native production configuration without browser-only values', () => {
    expect(validateBuildConfiguration(parseBuildProfile('native-production'), {
      backendBaseUrl: 'https://api.dupert.test',
    })).toBe('https://api.dupert.test')
  })
})
