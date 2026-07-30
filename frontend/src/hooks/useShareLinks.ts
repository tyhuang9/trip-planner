import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'
import axios from 'axios'
import { useCallback, useMemo, useState } from 'react'
import {
  acceptGuestShareLink,
  acceptShareLink,
  claimGuestSession,
  createShareLink,
  listTripMembers,
  listShareLinks,
  removeTripMember,
  renameShareLink,
  revokeShareLink,
} from '../api/share'
import { tripKeys } from './useTrips'
import type {
  AcceptGuestShareLinkRequest,
  AcceptGuestShareLinkResponse,
  AcceptShareLinkResponse,
  CreatedShareLink,
  CreateShareLinkRequest,
  RenameShareLinkRequest,
  ShareLink,
  TripMember,
} from '../types/share'
import type { Trip } from '../types/trip'

export const shareKeys = {
  all: ['share-links'] as const,
  forTrip: (publicId: string) => [...shareKeys.all, publicId] as const,
  members: (publicId: string) => ['trip-members', publicId] as const,
}

interface EphemeralMutationResult<TData, TVariables> {
  mutateAsync: (variables: TVariables) => Promise<TData>
  isPending: boolean
  error: Error | null
  reset: () => void
}

interface SafeMutationErrorData {
  error?: string
  fieldErrors?: Array<{ field: string; message: string }>
}

const SAFE_SHARE_FIELD_MESSAGES: Record<string, ReadonlySet<string>> = {
  displayName: new Set([
    'displayName is required',
    'displayName must not exceed 200 characters',
  ]),
  token: new Set(['token is required', 'token format is invalid']),
}

function useEphemeralMutation<TData, TVariables>(
  operation: (variables: TVariables) => Promise<TData>,
  onSuccess?: (data: TData) => void,
): EphemeralMutationResult<TData, TVariables> {
  const [isPending, setIsPending] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const reset = useCallback(() => {
    setIsPending(false)
    setError(null)
  }, [])

  const mutateAsync = useCallback(async (variables: TVariables) => {
    setIsPending(true)
    setError(null)
    try {
      const data = await operation(variables)
      onSuccess?.(data)
      setIsPending(false)
      return data
    } catch (caught) {
      const safeError = sanitizeMutationError(caught)
      setIsPending(false)
      setError(safeError)
      throw safeError
    }
  }, [onSuccess, operation])

  return useMemo(() => ({ mutateAsync, isPending, error, reset }), [
    error,
    isPending,
    mutateAsync,
    reset,
  ])
}

function sanitizeMutationError(caught: unknown): Error {
  if (!axios.isAxiosError(caught)) {
    return new Error('Share acceptance failed.')
  }

  const error = new Error('Share acceptance failed.') as Error & {
    isAxiosError: true
    response?: { status: number; data: SafeMutationErrorData }
  }
  error.name = 'AxiosError'
  error.isAxiosError = true
  if (caught.response) {
    const responseData = caught.response.data
    const code = responseData && typeof responseData === 'object'
      && 'error' in responseData
      && typeof responseData.error === 'string'
      && /^[a-z0-9_]{1,64}$/.test(responseData.error)
      ? responseData.error
      : undefined
    const fieldErrors = responseData && typeof responseData === 'object'
      && 'fieldErrors' in responseData
      && Array.isArray(responseData.fieldErrors)
      ? responseData.fieldErrors.flatMap((entry: unknown) => {
          if (!entry || typeof entry !== 'object'
              || !('field' in entry) || typeof entry.field !== 'string'
              || !('message' in entry) || typeof entry.message !== 'string'
              || !SAFE_SHARE_FIELD_MESSAGES[entry.field]?.has(entry.message)) {
            return []
          }
          return [{ field: entry.field, message: entry.message }]
        }).slice(0, 2)
      : []
    error.response = {
      status: caught.response.status,
      data: {
        ...(code ? { error: code } : {}),
        ...(fieldErrors.length > 0 ? { fieldErrors } : {}),
      },
    }
  }
  return error
}

function upsertShareLink(existing: ShareLink[] | undefined, link: ShareLink): ShareLink[] {
  return [link, ...(existing ?? []).filter((item) => item.id !== link.id)]
}

function shareLinkSummary(link: CreatedShareLink): ShareLink {
  return {
    id: link.id,
    name: link.name,
    role: link.role,
    allowAnonymous: link.allowAnonymous,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
    revokedAt: link.revokedAt,
  }
}

function upsertTrip(existing: Trip[] | undefined, trip: Trip): Trip[] {
  return [trip, ...(existing ?? []).filter((item) => item.publicId !== trip.publicId)]
}

export function useShareLinks(
  publicId: string | undefined,
): UseQueryResult<ShareLink[]> {
  return useQuery({
    queryKey: shareKeys.forTrip(publicId ?? ''),
    queryFn: () => listShareLinks(publicId as string),
    enabled: Boolean(publicId),
  })
}

export function useTripMembers(
  publicId: string | undefined,
): UseQueryResult<TripMember[]> {
  return useQuery({
    queryKey: shareKeys.members(publicId ?? ''),
    queryFn: () => listTripMembers(publicId as string),
    enabled: Boolean(publicId),
  })
}

export function useRemoveTripMember(): UseMutationResult<
  void,
  Error,
  { publicId: string; userId: number }
> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ publicId, userId }) => removeTripMember(publicId, userId),
    onSuccess: (_unused, { publicId, userId }) => {
      queryClient.setQueryData<TripMember[]>(
        shareKeys.members(publicId),
        (existing) => existing?.filter((member) => member.userId !== userId) ?? existing,
      )
      void queryClient.invalidateQueries({ queryKey: shareKeys.members(publicId) })
    },
  })
}

export function useCreateShareLink(): UseMutationResult<
  CreatedShareLink,
  Error,
  { publicId: string; body: CreateShareLinkRequest }
> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ publicId, body }) => createShareLink(publicId, body),
    onSuccess: (link, { publicId }) => {
      queryClient.setQueryData<ShareLink[]>(
        shareKeys.forTrip(publicId),
        (existing) => upsertShareLink(existing, shareLinkSummary(link)),
      )
    },
  })
}

export function useRevokeShareLink(): UseMutationResult<
  void,
  Error,
  { publicId: string; linkId: number }
> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ publicId, linkId }) => revokeShareLink(publicId, linkId),
    onSuccess: (_unused, { publicId, linkId }) => {
      queryClient.setQueryData<ShareLink[]>(
        shareKeys.forTrip(publicId),
        (existing) => existing?.filter((link) => link.id !== linkId) ?? existing,
      )
    },
  })
}

export function useRenameShareLink(): UseMutationResult<
  ShareLink,
  Error,
  { publicId: string; linkId: number; body: RenameShareLinkRequest }
> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ publicId, linkId, body }) => renameShareLink(publicId, linkId, body),
    onSuccess: (updatedLink, { publicId }) => {
      queryClient.setQueryData<ShareLink[]>(
        shareKeys.forTrip(publicId),
        (existing) =>
          existing?.map((link) =>
            link.id === updatedLink.id ? { ...link, ...updatedLink } : link,
          ) ?? existing,
      )
    },
  })
}

export function useAcceptShareLink(): EphemeralMutationResult<
  AcceptShareLinkResponse,
  string
> {
  const queryClient = useQueryClient()
  const onSuccess = useCallback((accepted: AcceptShareLinkResponse) => {
    void queryClient.invalidateQueries({ queryKey: tripKeys.lists() })
    void queryClient.invalidateQueries({
      queryKey: tripKeys.detail(accepted.publicId),
    })
  }, [queryClient])

  return useEphemeralMutation(acceptShareLink, onSuccess)
}

export function useAcceptGuestShareLink(): EphemeralMutationResult<
  AcceptGuestShareLinkResponse,
  { token: string; body: AcceptGuestShareLinkRequest }
> {
  const acceptGuest = useCallback(
    ({ token, body }: { token: string; body: AcceptGuestShareLinkRequest }) =>
      acceptGuestShareLink(token, body),
    [],
  )
  return useEphemeralMutation(acceptGuest)
}

export function useClaimGuestSession(): UseMutationResult<Trip, Error, void> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: claimGuestSession,
    onSuccess: (trip) => {
      queryClient.setQueryData(tripKeys.detail(trip.publicId), trip)
      queryClient.setQueryData<Trip[]>(tripKeys.lists(), (existing) =>
        upsertTrip(existing, trip),
      )
      void queryClient.invalidateQueries({ queryKey: tripKeys.lists() })
    },
  })
}
