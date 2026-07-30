import type { BuildTarget, DeploymentEnvironment } from './buildProfile'

declare global {
  const __DUPERT_BUILD_TARGET__: BuildTarget
  const __DUPERT_DEPLOYMENT_ENVIRONMENT__: DeploymentEnvironment
  const __DUPERT_BACKEND_BASE_URL__: string
}

export {}
