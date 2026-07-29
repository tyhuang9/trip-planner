import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RouteLoadingFallback } from './RouteLoadingFallback'

describe('RouteLoadingFallback', () => {
  it('renders a visible polite status inside the persistent main landmark', () => {
    render(<RouteLoadingFallback kind="auth" />)
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Loading sign-in page')
    expect(screen.getByRole('status')).not.toHaveClass('sr-only')
  })
})
