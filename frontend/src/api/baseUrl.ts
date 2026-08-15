const BACKEND_API_PATH_PREFIX = '/api'

type ApiQueryParams = Record<string, string | number | boolean | null | undefined>

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z\d+\-.]*:\/\//i.test(value)
}

export function normalizeBackendBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim()
  if (!trimmed) return ''

  let baseUrl = trimmed.replace(/\/+$/, '')
  if (!baseUrl) return ''

  if (!isAbsoluteUrl(baseUrl) && !baseUrl.startsWith('/')) {
    baseUrl = `/${baseUrl}`
  }

  if (baseUrl === BACKEND_API_PATH_PREFIX) return ''
  if (baseUrl.endsWith(BACKEND_API_PATH_PREFIX)) {
    return baseUrl.slice(0, -BACKEND_API_PATH_PREFIX.length)
  }

  return baseUrl
}

export function normalizeBackendApiBaseUrl(value: string | undefined): string {
  return `${normalizeBackendBaseUrl(value)}${BACKEND_API_PATH_PREFIX}`
}

const configuredBackendApiUrl =
  __DUPERT_BACKEND_BASE_URL__

export const backendBaseUrl = normalizeBackendBaseUrl(configuredBackendApiUrl)

export const backendApiBaseUrl = `${backendBaseUrl}${BACKEND_API_PATH_PREFIX}`

function normalizeApiPath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`
}

function appendQueryParams(url: string, params: ApiQueryParams): string {
  const origin = typeof window === 'undefined'
    ? 'http://localhost'
    : window.location.origin
  const parsed = new URL(url, origin)

  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) {
      parsed.searchParams.set(key, String(value))
    }
  }

  if (isAbsoluteUrl(url)) {
    return parsed.toString()
  }

  return `${parsed.pathname}${parsed.search}`
}

export function buildApiUrl(
  path: string,
  params?: ApiQueryParams,
): string {
  const url = `${backendApiBaseUrl}${normalizeApiPath(path)}`
  return params ? appendQueryParams(url, params) : url
}
