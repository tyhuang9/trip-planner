export type BuildTarget = 'web' | 'native'

export type DeploymentEnvironment = 'development' | 'staging' | 'production'

export interface BuildProfile {
  target: BuildTarget
  environment: DeploymentEnvironment
  mode: `${BuildTarget}-${DeploymentEnvironment}`
}

export interface PublicBuildConfiguration {
  backendBaseUrl?: string
  browserMapsApiKey?: string
  appAccessPassword?: string
}

const SUPPORTED_PROFILES: readonly BuildProfile[] = [
  { target: 'web', environment: 'development', mode: 'web-development' },
  { target: 'web', environment: 'staging', mode: 'web-staging' },
  { target: 'web', environment: 'production', mode: 'web-production' },
  { target: 'native', environment: 'development', mode: 'native-development' },
  { target: 'native', environment: 'staging', mode: 'native-staging' },
  { target: 'native', environment: 'production', mode: 'native-production' },
]

const LEGACY_VITE_MODES: Readonly<Record<string, BuildProfile>> = {
  development: SUPPORTED_PROFILES[0],
  production: SUPPORTED_PROFILES[2],
  test: SUPPORTED_PROFILES[0],
}

function trimmed(value: string | undefined): string {
  return value?.trim() ?? ''
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0.0.0.0'
    || normalized.startsWith('127.')
    || normalized.startsWith('::ffff:127.')
}

function isPlaceholderBackendUrl(configured: string, hostname: string): boolean {
  const normalizedHost = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return /(?:replace|placeholder|your[-_]?backend|change[-_]?me|<|>)/i.test(configured)
    || normalizedHost === 'example.com'
    || normalizedHost.endsWith('.example.com')
    || normalizedHost.endsWith('.example')
    || normalizedHost.endsWith('.invalid')
}

export function supportedBuildModes(): readonly BuildProfile[] {
  return SUPPORTED_PROFILES
}

export function parseBuildProfile(mode: string): BuildProfile {
  const profile = SUPPORTED_PROFILES.find((candidate) => candidate.mode === mode)
  if (!profile) {
    throw new Error(
      `Unsupported Dupert build mode "${mode}". Use one of: ${SUPPORTED_PROFILES.map((candidate) => candidate.mode).join(', ')}.`,
    )
  }
  return profile
}

/**
 * Vite and Vitest use their own implicit modes. Keep those compatibility shims
 * at the configuration boundary; application code only observes explicit
 * immutable web/native profiles.
 */
export function resolveBuildProfile(mode: string): BuildProfile {
  return LEGACY_VITE_MODES[mode] ?? parseBuildProfile(mode)
}

export function validateNativeBackendUrl(value: string | undefined, profile: BuildProfile): string {
  const configured = trimmed(value)
  if (profile.target !== 'native') {
    return configured
  }
  if (!configured) {
    throw new Error(`Native ${profile.environment} builds require VITE_BACKEND_API_URL to be an absolute backend URL.`)
  }

  let parsed: URL
  try {
    parsed = new URL(configured)
  } catch {
    throw new Error(`Native ${profile.environment} builds require VITE_BACKEND_API_URL to be an absolute URL.`)
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('VITE_BACKEND_API_URL must use http or https.')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('VITE_BACKEND_API_URL must not contain credentials, query parameters, or a fragment.')
  }
  if (
    (profile.environment === 'staging' || profile.environment === 'production')
    && (
      parsed.protocol !== 'https:'
      || isLoopbackHost(parsed.hostname)
      || isPlaceholderBackendUrl(configured, parsed.hostname)
    )
  ) {
    throw new Error(
      `Native ${profile.environment} VITE_BACKEND_API_URL must use a deployed HTTPS endpoint, not localhost, a loopback address, or a placeholder.`,
    )
  }

  return configured.replace(/\/+$/, '')
}

export function validateBuildConfiguration(
  profile: BuildProfile,
  configuration: PublicBuildConfiguration,
): string {
  const backendBaseUrl = validateNativeBackendUrl(configuration.backendBaseUrl, profile)

  if (profile.target === 'native' && profile.environment === 'production') {
    if (trimmed(configuration.browserMapsApiKey)) {
      throw new Error('Native production builds must not configure browser Google Maps (VITE_GOOGLE_MAPS_API_KEY).')
    }
    if (trimmed(configuration.appAccessPassword)) {
      throw new Error('Native production builds must not configure VITE_APP_ACCESS_PASSWORD.')
    }
  }

  return backendBaseUrl
}
