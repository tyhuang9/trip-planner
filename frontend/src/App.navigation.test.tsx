import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { NotFoundPage } from './App'
import { SkipLink } from './components/SkipLink'

describe('NotFoundPage accessibility', () => {
  it('sets the title, exposes the skip target, and focuses the heading', async () => {
    render(<MemoryRouter><SkipLink /><NotFoundPage /></MemoryRouter>)

    const main = screen.getByRole('main')
    const heading = screen.getByRole('heading', { name: /404.*not found/i })
    expect(main).toHaveAttribute('id', 'main')
    expect(screen.getByRole('link', { name: /skip to main content/i })).toHaveAttribute('href', '#main')
    await waitFor(() => expect(document.title).toBe('Page not found – Dupert'))
    expect(heading).toHaveFocus()
  })
})
