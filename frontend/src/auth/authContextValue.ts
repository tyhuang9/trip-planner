import { createContext } from 'react'
import type {
  LoginRequest,
  EmailVerificationResendRequest,
  RegisterRequest,
  RegisterResponse,
  UpdateProfileRequest,
  UserSummary,
} from '../types/auth'
import type { AuthStatus } from './authStore'

/**
 * Auth context shape exposed to the rest of the app. The state fields
 * (`user`, `isAuthenticated`) are sourced from the zustand store via
 * selectors so React re-renders whenever the underlying token/user
 * changes.
 *
 * Lives in its own file (separate from `AuthContext.tsx`) so the
 * provider module can stay component-only — react-refresh requires
 * that for HMR to work cleanly.
 */
export interface AuthContextValue {
  authStatus: AuthStatus
  user: UserSummary | null
  isAuthenticated: boolean
  /**
   * True until the silent-refresh probe on first mount has settled.
   * UI guards (e.g. a `RequireAuth` wrapper) should withhold redirects
   * while this is true, otherwise a logged-in user briefly bounces to
   * /login on every cold load.
   */
  isInitializing: boolean
  retryAuthResolution: () => Promise<void>
  login: (body: LoginRequest) => Promise<UserSummary>
  register: (body: RegisterRequest) => Promise<RegisterResponse>
  updateProfile: (body: UpdateProfileRequest) => Promise<UserSummary>
  changePassword: (body: { currentPassword: string; newPassword: string }) => Promise<void>
  requestPasswordReset: (body: { email: string }) => Promise<void>
  resendEmailVerification: (body: EmailVerificationResendRequest) => Promise<void>
  logout: () => Promise<void>
  deleteAccount: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)
