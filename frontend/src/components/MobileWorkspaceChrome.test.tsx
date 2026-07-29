import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { MobileWorkspaceChrome } from './MobileWorkspaceChrome'
import styles from './MobileWorkspaceChrome.module.css'

const currentDir = dirname(fileURLToPath(import.meta.url))
const chromeCss = readFileSync(join(currentDir, 'MobileWorkspaceChrome.module.css'), 'utf8')

function cssBlocks(css: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...css.matchAll(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, 'g'))].map(
    (match) => match[1],
  )
}

interface RenderChromeOptions {
  canEditTrip?: boolean
  isAuthenticated?: boolean
  onOpenSettings?: () => void
  onOpenShare?: () => void
}

function renderChrome({
  canEditTrip = true,
  isAuthenticated = true,
  onOpenSettings = vi.fn(),
  onOpenShare = vi.fn(),
}: RenderChromeOptions = {}) {
  return render(
    <MemoryRouter>
      <MobileWorkspaceChrome
        activeTab="map"
        canEditTrip={canEditTrip}
        isAuthenticated={isAuthenticated}
        onOpenSettings={onOpenSettings}
        onOpenShare={onOpenShare}
        onSelectTab={vi.fn()}
        publicId="abc123"
        tripName="Monterey"
      />
    </MemoryRouter>,
  )
}

async function openDrawer() {
  const trigger = screen.getByRole('button', { name: /open trip menu/i })
  await userEvent.click(trigger)
  const drawer = await screen.findByRole('dialog', { name: /monterey/i })
  return { drawer, trigger }
}

describe('<MobileWorkspaceChrome>', () => {
  it('renders a labelled right-aligned popup dialog and initially focuses its close control', async () => {
    renderChrome()

    const { drawer: popup, trigger } = await openDrawer()

    expect(popup).toHaveClass(styles.menuPopup)
    expect(trigger).toHaveAttribute('aria-controls', 'mobile-trip-menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /close trip menu/i })).toHaveFocus()
    })
  })

  it('traps keyboard focus inside the trip popup', async () => {
    const user = userEvent.setup()
    renderChrome()

    await user.click(screen.getByRole('button', { name: /open trip menu/i }))
    await screen.findByRole('dialog', { name: /monterey/i })
    const closeButton = screen.getByRole('button', { name: /close trip menu/i })

    await waitFor(() => expect(closeButton).toHaveFocus())
    await user.tab({ shift: true })
    expect(screen.getByRole('button', { name: /trip settings/i })).toHaveFocus()
    await user.tab()
    expect(closeButton).toHaveFocus()
  })

  it('closes on Escape or backdrop dismissal and restores focus to the menu trigger', async () => {
    const user = userEvent.setup()
    renderChrome()

    const { trigger } = await openDrawer()
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /monterey/i })).not.toBeInTheDocument()
      expect(trigger).toHaveFocus()
    })

    await user.click(trigger)
    const reopenedDrawer = await screen.findByRole('dialog', { name: /monterey/i })
    fireEvent.mouseDown(reopenedDrawer.parentElement as HTMLElement)
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /monterey/i })).not.toBeInTheDocument()
      expect(trigger).toHaveFocus()
    })
  })

  it('keeps members authenticated-only and hides editable actions for view-only members', async () => {
    const user = userEvent.setup()
    renderChrome({
      isAuthenticated: true,
      canEditTrip: false,
    })

    await user.click(screen.getByRole('button', { name: /open trip menu/i }))
    expect(screen.getByRole('link', { name: /members/i })).toHaveAttribute('href', '/trips/abc123/members')
    expect(screen.queryByRole('button', { name: /share trip/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /trip settings/i })).not.toBeInTheDocument()
  })

  it('hides Members for guests', async () => {
    const user = userEvent.setup()
    renderChrome({ isAuthenticated: false, canEditTrip: false })

    await user.click(screen.getByRole('button', { name: /open trip menu/i }))
    expect(screen.queryByRole('link', { name: /members/i })).not.toBeInTheDocument()
  })

  it('routes editable actions through their callbacks', async () => {
    const user = userEvent.setup()
    const onOpenShare = vi.fn()
    const onOpenSettings = vi.fn()
    renderChrome({ onOpenShare, onOpenSettings })

    const { trigger } = await openDrawer()
    await user.click(screen.getByRole('button', { name: /share trip/i }))
    expect(onOpenShare).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog', { name: /monterey/i })).not.toBeInTheDocument()

    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: /trip settings/i }))
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('keeps the menu as a right-aligned, viewport-bounded popup instead of a full-height drawer', () => {
    const backdropBlock = cssBlocks(chromeCss, '.menuBackdrop')[0] ?? ''
    const popupBlock = cssBlocks(chromeCss, '.menuPopup')[0] ?? ''
    const headerBlock = cssBlocks(chromeCss, '.menuHeader')[0] ?? ''
    const actionsBlock = cssBlocks(chromeCss, '.menuActions')[0] ?? ''

    expect(backdropBlock).toMatch(/background:\s*rgb\(26 33 31 \/ 22%\)/)
    expect(popupBlock).toMatch(/position:\s*absolute/)
    expect(popupBlock).toMatch(/--menu-control-top:\s*10px/)
    expect(popupBlock).toMatch(/top:\s*0/)
    expect(popupBlock).toMatch(/right:\s*0/)
    expect(popupBlock).toMatch(/width:\s*min\(22rem,\s*calc\(100vw - var\(--space-6\)\)\)/)
    expect(popupBlock).toMatch(/max-height:\s*calc\(100dvh - 8rem - var\(--space-4\) - env\(safe-area-inset-bottom\)\)/)
    expect(popupBlock).toMatch(/border-radius:\s*var\(--radius-xl\)/)
    expect(popupBlock).toMatch(/overflow:\s*hidden/)
    expect(popupBlock).not.toMatch(/height:\s*100dvh/)
    expect(headerBlock).toMatch(/padding:\s*var\(--menu-control-top\) var\(--space-4\) var\(--space-4\)/)
    expect(actionsBlock).toMatch(/overflow-y:\s*auto/)
  })
})
