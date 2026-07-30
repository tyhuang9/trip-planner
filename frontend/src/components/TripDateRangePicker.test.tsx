import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TripDateRangePicker } from './TripDateRangePicker'

function mockFieldRect(rect: Partial<DOMRect> = {}) {
  const field = screen.getByText('Trip dates').closest('div')
  if (!(field instanceof HTMLElement)) {
    throw new Error('Date range field was not rendered')
  }
  vi.spyOn(field, 'getBoundingClientRect').mockReturnValue({
    bottom: 144,
    height: 96,
    left: 40,
    right: 400,
    top: 48,
    width: 360,
    x: 40,
    y: 48,
    ...rect,
    toJSON: () => ({}),
  })
}

describe('<TripDateRangePicker>', () => {
  it('renders the calendar as an anchored portal outside the containing popup', async () => {
    const onChange = vi.fn()

    render(
      <div data-testid="settings-popup">
        <TripDateRangePicker
          startDate="2026-05-01"
          endDate=""
          onChange={onChange}
        />
      </div>,
    )
    mockFieldRect()

    const trigger = screen.getByRole('button', { name: /trip dates/i })
    await userEvent.click(trigger)

    const dialog = screen.getByRole('dialog', { name: /trip dates/i })
    expect(trigger).toHaveAttribute('data-panel-placement', 'below')
    expect(screen.getByTestId('settings-popup')).not.toContainElement(dialog)
    expect(document.body).toContainElement(dialog)
    expect(dialog).toContainElement(screen.getByRole('button', { name: /previous month/i }))
    expect(dialog).toContainElement(screen.getByRole('button', { name: /next month/i }))
    expect(within(dialog).queryByRole('button', { name: /reset/i })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /fri, may 1/i })).not.toBeInTheDocument()
    expect(dialog).toHaveStyle({
      left: '40px',
      position: 'fixed',
      top: '143px',
      width: '760px',
    })
    expect(dialog.style.maxHeight).toBe('')
  })

  it('opens above the field when there is more room above than below', async () => {
    const onChange = vi.fn()

    render(
      <TripDateRangePicker
        startDate="2026-05-01"
        endDate=""
        onChange={onChange}
      />,
    )
    mockFieldRect({
      bottom: 690,
      height: 70,
      left: 82,
      right: 520,
      top: 620,
      width: 438,
      x: 82,
      y: 620,
    })

    const trigger = screen.getByRole('button', { name: /trip dates/i })
    await userEvent.click(trigger)

    const dialog = screen.getByRole('dialog', { name: /trip dates/i })
    expect(trigger).toHaveAttribute('data-panel-placement', 'above')
    expect(dialog).toHaveAttribute('data-placement', 'above')
    expect(dialog.style.top).toBe('')
    expect(dialog).toHaveStyle({
      bottom: '147px',
      left: '82px',
      position: 'fixed',
      width: '760px',
    })
    expect(dialog.style.maxHeight).toBe('')
  })

  it('keeps a compact above-field calendar connected to its trigger', async () => {
    vi.stubGlobal('innerWidth', 390)
    vi.stubGlobal('innerHeight', 768)

    try {
      render(
        <TripDateRangePicker
          startDate="2026-05-01"
          endDate=""
          onChange={vi.fn()}
        />,
      )
      mockFieldRect({
        bottom: 690,
        height: 70,
        left: 16,
        right: 374,
        top: 620,
        width: 358,
        x: 16,
        y: 620,
      })

      const trigger = screen.getByRole('button', { name: /trip dates/i })
      await userEvent.click(trigger)

      const dialog = screen.getByRole('dialog', { name: /trip dates/i })
      expect(trigger).toHaveAttribute('data-panel-placement', 'above')
      expect(dialog).toHaveStyle({
        bottom: '147px',
        left: '12px',
        position: 'fixed',
        width: '366px',
      })
      expect(dialog.querySelector('[data-month-count="1"]')).toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps date selection working inside the portaled calendar', async () => {
    const onChange = vi.fn()

    render(
      <TripDateRangePicker
        startDate="2026-05-01"
        endDate=""
        onChange={onChange}
      />,
    )
    mockFieldRect()

    await userEvent.click(screen.getByRole('button', { name: /trip dates/i }))
    await userEvent.click(screen.getByRole('button', {
      name: /choose sunday, may 3, 2026/i,
    }))

    expect(onChange).toHaveBeenCalledWith({ endDate: '2026-05-03' })
  })

  it('starts a new range when reopening an existing range from the trigger', async () => {
    const onChange = vi.fn()

    render(
      <TripDateRangePicker
        startDate="2026-05-01"
        endDate="2026-05-03"
        onChange={onChange}
      />,
    )
    mockFieldRect()

    await userEvent.click(screen.getByRole('button', { name: /trip dates/i }))
    await userEvent.click(screen.getByRole('button', {
      name: /choose tuesday, may 5, 2026/i,
    }))

    expect(onChange).toHaveBeenCalledWith({
      startDate: '2026-05-05',
      endDate: '',
    })
  })

  it('refocuses on the start date after choosing an end date', async () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <TripDateRangePicker
        startDate="2026-05-01"
        endDate=""
        onChange={onChange}
      />,
    )
    mockFieldRect()

    await userEvent.click(screen.getByRole('button', { name: /trip dates/i }))
    await userEvent.click(screen.getByRole('button', {
      name: /choose sunday, may 3, 2026/i,
    }))

    expect(onChange).toHaveBeenLastCalledWith({ endDate: '2026-05-03' })

    rerender(
      <TripDateRangePicker
        startDate="2026-05-01"
        endDate="2026-05-03"
        onChange={onChange}
      />,
    )

    await userEvent.click(screen.getByRole('button', {
      name: /choose tuesday, may 5, 2026/i,
    }))

    expect(onChange).toHaveBeenLastCalledWith({
      startDate: '2026-05-05',
      endDate: '',
    })
  })

  it('closes the portaled calendar on Escape', async () => {
    const onChange = vi.fn()

    render(
      <TripDateRangePicker
        startDate="2026-05-01"
        endDate=""
        onChange={onChange}
      />,
    )
    mockFieldRect()

    const trigger = screen.getByRole('button', { name: /trip dates/i })
    await userEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: /trip dates/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /choose friday, may 1, 2026/i })).toHaveFocus()

    await userEvent.keyboard('{Escape}')

    await vi.waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /trip dates/i })).not.toBeInTheDocument()
      expect(trigger).toHaveFocus()
    })
  })
})
