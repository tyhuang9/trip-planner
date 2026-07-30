import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './ConfirmDialog'

afterEach(() => {
  cleanup()
})

function renderDialog({ confirming = false } = {}) {
  const onCancel = vi.fn()
  const onConfirm = vi.fn()
  const rendered = render(
    <ConfirmDialog
      title="Delete activity?"
      description="This cannot be undone."
      confirmLabel="Delete activity"
      confirming={confirming}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  )

  return { ...rendered, onCancel, onConfirm }
}

describe('<ConfirmDialog>', () => {
  it('keeps the dialog open when Cancel is activated while confirming', async () => {
    const { onCancel, onConfirm, rerender } = renderDialog({ confirming: true })

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deleting...' })).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await userEvent.click(screen.getByRole('button', { name: 'Deleting...' }))
    expect(onCancel).not.toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()

    rerender(
      <ConfirmDialog
        title="Delete activity?"
        description="This cannot be undone."
        confirmLabel="Delete activity"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('ignores Escape while confirming and restores Escape dismissal afterwards', () => {
    const { onCancel, onConfirm, rerender } = renderDialog({ confirming: true })

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()

    rerender(
      <ConfirmDialog
        title="Delete activity?"
        description="This cannot be undone."
        confirmLabel="Delete activity"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    )

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('ignores backdrop dismissal while confirming and restores it afterwards', () => {
    const { onCancel, onConfirm, rerender } = renderDialog({ confirming: true })
    const dialog = screen.getByRole('alertdialog', { name: 'Delete activity?' })
    const backdrop = dialog.parentElement

    if (!backdrop) throw new Error('Confirm dialog backdrop is missing.')

    fireEvent.mouseDown(backdrop)
    expect(onCancel).not.toHaveBeenCalled()

    rerender(
      <ConfirmDialog
        title="Delete activity?"
        description="This cannot be undone."
        confirmLabel="Delete activity"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    )

    fireEvent.mouseDown(backdrop)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
