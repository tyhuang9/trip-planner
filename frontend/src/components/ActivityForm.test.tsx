import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActivityForm } from './ActivityForm'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('<ActivityForm>', () => {
  it('autofocuses the activity name without scrolling the mobile viewport', () => {
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus')

    render(
      <ActivityForm
        autoFocusTitle
        onSubmit={vi.fn()}
        submitting={false}
      />,
    )

    expect(screen.getByRole('textbox', { name: /activity name/i })).toHaveFocus()
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true })
  })
})
