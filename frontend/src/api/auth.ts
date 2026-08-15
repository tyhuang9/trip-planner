import {
  apiClient,
  AUTH_COOKIE_ACTION_HEADER,
  AUTH_COOKIE_ACTION_VALUE,
} from './client'
import type {
  AuthResponse,
  ChangePasswordRequest,
  DeleteAccountRequest,
  EmailVerificationRequest,
  EmailVerificationResendRequest,
  LoginRequest,
  PasswordResetConfirmRequest,
  PasswordResetRequest,
  RegisterRequest,
  RegisterResponse,
  UpdateProfileRequest,
  UserSummary,
} from '../types/auth'

/**
 * Thin wrappers around the `/api/auth/*` endpoints. These return the
 * parsed response bodies and let axios errors propagate; callers
 * (the AuthContext, mostly) decide how to surface failures.
 *
 * The logout endpoint relies on the HttpOnly refresh cookie —
 * `withCredentials: true` is set on the shared axios instance so the
 * browser sends it automatically.
 *
 * Note: there is intentionally no `refresh()` export here. All refresh
 * calls go through `refreshSession()` in `./client.ts`, which uses a
 * bare axios instance (so it bypasses the response interceptor) and a
 * shared dedupe singleton.
 */

export async function register(body: RegisterRequest): Promise<RegisterResponse> {
  const { data } = await apiClient.post<RegisterResponse>('/auth/register', body)
  return data
}

export async function login(body: LoginRequest): Promise<AuthResponse> {
  const { data } = await apiClient.post<AuthResponse>('/auth/login', body)
  return data
}

export async function logout(): Promise<void> {
  await apiClient.post('/auth/logout', undefined, {
    headers: { [AUTH_COOKIE_ACTION_HEADER]: AUTH_COOKIE_ACTION_VALUE },
  })
}

export async function getMe(): Promise<UserSummary> {
  const { data } = await apiClient.get<UserSummary>('/auth/me')
  return data
}

export async function updateProfile(body: UpdateProfileRequest): Promise<UserSummary> {
  const { data } = await apiClient.patch<UserSummary>('/auth/me/profile', body)
  return data
}

export async function changePassword(body: ChangePasswordRequest): Promise<void> {
  await apiClient.post('/auth/me/password', body)
}

export async function requestPasswordReset(body: PasswordResetRequest): Promise<void> {
  await apiClient.post('/auth/password-reset/request', body)
}

export async function confirmPasswordReset(body: PasswordResetConfirmRequest): Promise<void> {
  await apiClient.post('/auth/password-reset/confirm', body)
}

export async function verifyEmail(
  body: EmailVerificationRequest,
): Promise<AuthResponse> {
  const { data } = await apiClient.post<AuthResponse>('/auth/email/verify', body)
  return data
}

export async function resendEmailVerification(
  body: EmailVerificationResendRequest,
): Promise<void> {
  await apiClient.post('/auth/email/resend', body)
}

export async function deleteMe(body: DeleteAccountRequest): Promise<void> {
  const response = await apiClient.delete('/auth/me', { data: body })
  if (response.status !== 204) {
    throw new Error('Account deletion was not confirmed.')
  }
}
