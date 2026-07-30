/**
 * Wire-format types matching the backend DTOs in
 * `backend/src/main/java/com/trip/web/dto/`. Kept narrow on purpose:
 * any field the frontend doesn't actively use is omitted so a backend
 * change that removes the field still typechecks.
 */

/** Mirrors `com.trip.web.dto.UserSummary`. */
export interface UserSummary {
  id: number
  email: string
  displayName: string
  emailVerified: boolean
}

/**
 * Mirrors `com.trip.web.dto.AuthResponse`. The refresh token is
 * intentionally NOT in the body — it lives only in the HttpOnly
 * `refresh_token` cookie set by the backend.
 */
export interface AuthResponse {
  accessToken: string
  tokenType: string
  expiresInSeconds: number
  user: UserSummary
}

export interface RegisterRequest {
  email: string
  password: string
  displayName: string
  returnPath?: string | null
}

export interface RegisterResponse {
  status: 'verification_required' | 'verified'
  email: string
}

export interface LoginRequest {
  email: string
  password: string
}

export interface UpdateProfileRequest {
  displayName: string
}

export interface ChangePasswordRequest {
  currentPassword: string
  newPassword: string
}

export interface DeleteAccountRequest {
  currentPassword: string
}

export interface PasswordResetRequest {
  email: string
}

export interface PasswordResetConfirmRequest {
  token: string
  password: string
}

export interface EmailVerificationRequest {
  token: string
}

export interface EmailVerificationResendRequest {
  email: string
  returnPath?: string | null
}
