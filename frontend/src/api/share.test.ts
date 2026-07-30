import axios from 'axios'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import MockAdapter from 'axios-mock-adapter'
import { apiClient } from './client'
import {
  acceptGuestShareLink,
  acceptShareLink,
  createShareLink,
  listTripMembers,
  listShareLinks,
  removeTripMember,
  revokeShareLink,
} from './share'
import type { CreatedShareLink, ShareLink } from '../types/share'

let apiMock: MockAdapter

const SHARE_LINK: ShareLink = {
  id: 12,
  role: 'EDITOR',
  allowAnonymous: false,
  createdAt: '2026-06-18T20:00:00Z',
  expiresAt: null,
  revokedAt: null,
}

const CREATED_LINK: CreatedShareLink = {
  ...SHARE_LINK,
  shareUrl: 'http://localhost:3000/share/raw-token',
}

beforeEach(() => {
  apiMock = new MockAdapter(apiClient)
})

afterEach(() => {
  apiMock.restore()
})

describe('share api', () => {
  it('lists share links for a trip', async () => {
    apiMock.onGet('/trips/abc234def567/share-links').reply(200, [SHARE_LINK])

    await expect(listShareLinks('abc234def567')).resolves.toEqual([SHARE_LINK])
  })

  it('lists trip members', async () => {
    apiMock.onGet('/trips/abc234def567/members').reply(200, [
      {
        userId: 7,
        email: 'alice@example.com',
        displayName: 'Alice',
        role: 'OWNER',
      },
    ])

    await expect(listTripMembers('abc234def567')).resolves.toEqual([
      {
        userId: 7,
        email: 'alice@example.com',
        displayName: 'Alice',
        role: 'OWNER',
      },
    ])
  })

  it('removes a trip member from the encoded trip path', async () => {
    apiMock.onDelete('/trips/abc%2F234/members/7').reply(204)

    await expect(removeTripMember('abc/234', 7)).resolves.toBeUndefined()
  })

  it('creates a share link', async () => {
    apiMock.onPost('/trips/abc234def567/share-links').reply((config) => [
      201,
      { ...CREATED_LINK, body: JSON.parse(config.data as string) },
    ])

    await expect(
      createShareLink('abc234def567', {
        role: 'VIEWER',
        allowAnonymous: true,
        expiresAt: null,
      }),
    ).resolves.toMatchObject({
      shareUrl: CREATED_LINK.shareUrl,
      body: {
        role: 'VIEWER',
        allowAnonymous: true,
        expiresAt: null,
      },
    })
  })

  it('revokes a share link', async () => {
    apiMock.onDelete('/trips/abc234def567/share-links/12').reply(204)

    await expect(revokeShareLink('abc234def567', 12)).resolves.toBeUndefined()
  })

  it('accepts an account invite', async () => {
    apiMock.onPost('/share/accept').reply((config) => [
      200,
      {
        publicId: 'abc234def567',
        role: 'EDITOR',
        body: JSON.parse(config.data as string),
      },
    ])

    await expect(acceptShareLink('raw-token')).resolves.toMatchObject({
      publicId: 'abc234def567',
      role: 'EDITOR',
      body: { token: 'raw-token' },
    })
    expect(apiMock.history.post[0]?.url).toBe('/share/accept')
    expect(apiMock.history.post[0]?.url).not.toContain('raw-token')
  })

  it('accepts a guest invite', async () => {
    apiMock.onPost('/share/guest').reply((config) => [
      200,
      {
        publicId: 'abc234def567',
        role: 'VIEWER',
        ...JSON.parse(config.data as string),
      },
    ])

    await expect(
      acceptGuestShareLink('raw-token', { displayName: 'Guest Alice' }),
    ).resolves.toEqual({
      publicId: 'abc234def567',
      role: 'VIEWER',
      displayName: 'Guest Alice',
      token: 'raw-token',
    })
    expect(apiMock.history.post[0]?.url).toBe('/share/guest')
    expect(apiMock.history.post[0]?.url).not.toContain('raw-token')
  })

  it('redacts share credentials from rejected Axios request configs', async () => {
    const token = 'sensitive-share-token-123456'
    apiMock.onPost('/share/accept').reply(404, { error: 'not_found' })

    const error = await acceptShareLink(token).catch((caught) => caught)

    expect(axios.isAxiosError(error)).toBe(true)
    expect(error.config?.url).toBe('/share/accept')
    expect(error.response?.status).toBe(404)
    expect(JSON.stringify(error.config)).not.toContain(token)
  })
})
