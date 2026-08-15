export interface NativeBundlePolicyEnvironment {
  VITE_APP_ACCESS_PASSWORD?: string
  VITE_GOOGLE_MAPS_API_KEY?: string
}

export function assertNativeBundlePolicy(
  directory: string,
  environment?: NativeBundlePolicyEnvironment,
): void
