import MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apiClient } from './client'
import { bootstrapGuestSession } from './guestSession'

let apiMock: MockAdapter

beforeEach(() => {
  apiMock = new MockAdapter(apiClient)
})

afterEach(() => {
  apiMock.restore()
})

describe('bootstrapGuestSession', () => {
  it('returns the safe current guest projection', async () => {
    apiMock.onGet('/guest-session/bootstrap').reply(200, {
      publicId: 'abc23def45gh',
      role: 'VIEWER',
      displayName: 'Guest',
    })

    await expect(bootstrapGuestSession()).resolves.toEqual({
      publicId: 'abc23def45gh',
      role: 'VIEWER',
      displayName: 'Guest',
    })
  })

  it('maps the uniform inactive response to no current session', async () => {
    apiMock.onGet('/guest-session/bootstrap').reply(204)

    await expect(bootstrapGuestSession()).resolves.toBeNull()
  })
})
