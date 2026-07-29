export type DeepLink =
  | { kind: 'share'; token: string }
  | { kind: 'share-guest'; token: string }
  | { kind: 'verify-email'; token: string; returnTo: DeepLinkReturn }
  | { kind: 'reset-password'; token: string }
  | { kind: 'trip'; publicId: string; day?: string }

const ORIGIN = 'https://dupert.vercel.app'
const MAX_SECRET_LENGTH = 512
const MAX_ID_LENGTH = 128
const SAFE_SECRET = /^[A-Za-z0-9_-]+$/
const SAFE_PUBLIC_ID = /^[a-z0-9]{1,24}$/

export type DeepLinkReturn = { kind: 'route'; path: string } | { kind: 'share'; token: string }

function hasUnsafeEncoding(value: string): boolean {
  return /%(?:2f|5c|2e|00|0a|0d)/i.test(value) || value.includes('\\')
}

function safeSecret(value: string | undefined): value is string {
  if (!value) return false
  return value.length <= MAX_SECRET_LENGTH && SAFE_SECRET.test(value)
}

function safePublicId(value: string | undefined): value is string {
  if (!value) return false
  return value.length <= MAX_ID_LENGTH && SAFE_PUBLIC_ID.test(value)
}

function safeDay(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function safeReturn(raw: string | null): DeepLinkReturn | null {
  if (raw === null) return { kind: 'route', path: '/trips' }
  if (raw.length > 512 || hasUnsafeEncoding(raw) || !raw.startsWith('/') || raw.startsWith('//')) return null
  const [path, query = ''] = raw.split('?')
  if (query || !path) return null
  if (path === '/' || path === '/trips' || path === '/login' || path === '/register') return { kind: 'route', path }
  const parts = path.split('/').slice(1)
  if (parts[0] === 'share' && parts.length === 2 && safeSecret(parts[1])) {
    return { kind: 'share', token: parts[1] }
  }
  if (parts[0] !== 'trips' || !safePublicId(parts[1])) return null
  if (parts.length === 2) return { kind: 'route', path }
  return parts.length === 4 && parts[2] === 'd' && safeDay(parts[3]) ? { kind: 'route', path } : null
}

function onlyQuery(url: URL, allowed: readonly string[]): boolean {
  const seen = new Set<string>()
  for (const [key] of url.searchParams) {
    if (!allowed.includes(key) || seen.has(key)) return false
    seen.add(key)
  }
  return true
}

/** Parses only the universal-link surface accepted by the native shell. */
export function parseDeepLink(rawUrl: string): DeepLink | null {
  const rawPath = rawUrl.slice(ORIGIN.length).split(/[?#]/, 1)[0]
  if (
    rawUrl.length > 2_048 ||
    rawUrl.includes('#') ||
    rawUrl.endsWith('?') ||
    rawUrl !== rawUrl.trim() ||
    /[\u0000-\u001f\u007f]/.test(rawUrl) ||
    !/^https:\/\/dupert\.vercel\.app(?:\/|\?|$)/.test(rawUrl) ||
    /\/(?:\.\.?)(?:\/|$)/.test(rawPath) ||
    hasUnsafeEncoding(rawPath)
  ) return null
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== ORIGIN ||
    url.port !== '' ||
    url.username ||
    url.password ||
    url.hash
  ) return null

  return parseDeepLinkPath(url.pathname, url.search)
}

/** Parses a browser location only after its host has already been trusted by BrowserRouter. */
export function parseDeepLinkPath(pathname: string, search = ''): DeepLink | null {
  if (pathname.length + search.length > 2_048 || hasUnsafeEncoding(pathname)) return null
  const url = new URL(`https://dupert.vercel.app${pathname}${search}`)
  const segments = url.pathname.split('/').slice(1)
  if (segments.some((segment) => hasUnsafeEncoding(segment))) return null
  if (segments[0] === 'share' && !url.search && search !== '?' && safeSecret(segments[1])) {
    if (segments.length === 2) return { kind: 'share', token: segments[1] }
    if (segments.length === 3 && segments[2] === 'guest') return { kind: 'share-guest', token: segments[1] }
  }
  if (url.pathname === '/verify-email' && onlyQuery(url, ['token', 'return'])) {
    const token = url.searchParams.get('token')
    const returnTo = safeReturn(url.searchParams.get('return'))
    const verificationToken = token ?? undefined
    if (safeSecret(verificationToken) && returnTo) return { kind: 'verify-email', token: verificationToken, returnTo }
  }
  if (url.pathname === '/reset-password' && onlyQuery(url, ['token', 'code'])) {
    const token = url.searchParams.get('token')
    const code = url.searchParams.get('code')
    const resetToken = token ?? code ?? undefined
    if (Boolean(token) !== Boolean(code) && safeSecret(resetToken)) {
      return { kind: 'reset-password', token: resetToken }
    }
  }
  if (segments[0] === 'trips' && !url.search && search !== '?' && safePublicId(segments[1])) {
    if (segments.length === 2) return { kind: 'trip', publicId: segments[1] }
    if (segments.length === 4 && segments[2] === 'd' && safeDay(segments[3])) {
      return { kind: 'trip', publicId: segments[1], day: segments[3] }
    }
  }
  return null
}

export function deepLinkTarget(link: DeepLink): string {
  if (link.kind !== 'trip') return '/link'
  return `/trips/${encodeURIComponent(link.publicId)}${link.day ? `/d/${encodeURIComponent(link.day)}` : ''}`
}
