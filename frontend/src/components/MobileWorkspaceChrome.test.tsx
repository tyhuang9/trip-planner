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
  onOpenMembers?: () => void
  onOpenSettings?: () => void
  onOpenShare?: () => void
}

function renderChrome({
  canEditTrip = true,
  isAuthenticated = true,
  onOpenMembers = vi.fn(),
  onOpenSettings = vi.fn(),
  onOpenShare = vi.fn(),
}: RenderChromeOptions = {}) {
  return render(
    <MemoryRouter>
      <MobileWorkspaceChrome
        activeTab="map"
        canEditTrip={canEditTrip}
        isAuthenticated={isAuthenticated}
        onOpenMembers={onOpenMembers}
        onOpenSettings={onOpenSettings}
        onOpenShare={onOpenShare}
        onSelectTab={vi.fn()}
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

    const { drawer: dialog, trigger } = await openDrawer()
    const popup = dialog.querySelector(`.${styles.menuPopup}`)
    const closeButton = screen.getByRole('button', { name: /close trip menu/i })

    expect(dialog).toHaveClass(styles.menuDialog)
    expect(popup).toBeInTheDocument()
    expect(dialog).toContainElement(closeButton)
    expect(popup).not.toContainElement(closeButton)
    expect(trigger).toHaveAttribute('aria-controls', 'mobile-trip-menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await waitFor(() => {
      expect(closeButton).toHaveFocus()
    })
  })

  it('closes from the relocated close control and restores focus to the menu trigger', async () => {
    const user = userEvent.setup()
    renderChrome()

    const { trigger } = await openDrawer()
    await user.click(screen.getByRole('button', { name: /close trip menu/i }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /monterey/i })).not.toBeInTheDocument()
      expect(trigger).toHaveFocus()
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
    expect(screen.getByRole('button', { name: /members/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /share trip/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /trip settings/i })).not.toBeInTheDocument()
  })

  it('hides Members for guests', async () => {
    const user = userEvent.setup()
    renderChrome({ isAuthenticated: false, canEditTrip: false })

    await user.click(screen.getByRole('button', { name: /open trip menu/i }))
    expect(screen.queryByRole('button', { name: /members/i })).not.toBeInTheDocument()
  })

  it('routes editable actions through their callbacks', async () => {
    const user = userEvent.setup()
    const onOpenMembers = vi.fn()
    const onOpenShare = vi.fn()
    const onOpenSettings = vi.fn()
    renderChrome({ onOpenMembers, onOpenShare, onOpenSettings })

    const { trigger } = await openDrawer()
    await user.click(screen.getByRole('button', { name: /members/i }))
    expect(onOpenMembers).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog', { name: /monterey/i })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()

    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: /share trip/i }))
    expect(onOpenShare).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog', { name: /monterey/i })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()

    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: /trip settings/i }))
    expect(onOpenSettings).toHaveBeenCalledOnce()
    expect(trigger).toHaveFocus()
  })

  it('keeps the menu as a right-aligned, viewport-bounded popup instead of a full-height drawer', () => {
    const chromeBlock = cssBlocks(chromeCss, '.chrome')[0] ?? ''
    const chromeHeaderBlock = cssBlocks(chromeCss, '.header')[0] ?? ''
    const brandBlock = cssBlocks(chromeCss, '.brand')[0] ?? ''
    const backdropBlock = cssBlocks(chromeCss, '.menuBackdrop')[0] ?? ''
    const popupBlock = cssBlocks(chromeCss, '.menuPopup')[0] ?? ''
    const menuHeaderBlock = cssBlocks(chromeCss, '.menuHeader')[0] ?? ''
    const actionsBlock = cssBlocks(chromeCss, '.menuActions')[0] ?? ''

    expect(backdropBlock).toMatch(/background:\s*rgb\(26 33 31 \/ 22%\)/)
    expect(chromeBlock).toMatch(/--workspace-chrome-control-top:\s*calc\(var\(--space-2\) \+ env\(safe-area-inset-top\)\)/)
    expect(chromeBlock).toMatch(/--workspace-chrome-control-right:\s*calc\(var\(--space-4\) \+ env\(safe-area-inset-right\)\)/)
    expect(chromeHeaderBlock).toMatch(
      /padding:\s*var\(--workspace-chrome-control-top\)\s*var\(--workspace-chrome-control-right\)\s*var\(--space-2\)\s*calc\(var\(--space-4\) \+ env\(safe-area-inset-left\)\)/,
    )
    expect(brandBlock).toMatch(/width:\s*44px/)
    expect(brandBlock).toMatch(/height:\s*44px/)
    expect(popupBlock).toMatch(/position:\s*absolute/)
    expect(popupBlock).toMatch(/top:\s*calc\(var\(--space-3\) \+ env\(safe-area-inset-top\)\)/)
    expect(popupBlock).toMatch(/right:\s*calc\(var\(--space-3\) \+ env\(safe-area-inset-right\)\)/)
    expect(popupBlock).toMatch(/width:\s*min\(22rem,\s*calc\(100vw - var\(--space-6\) - env\(safe-area-inset-left\) - env\(safe-area-inset-right\)\)\)/)
    expect(popupBlock).toMatch(/max-height:\s*calc\(100dvh - 8rem - var\(--space-4\) - env\(safe-area-inset-bottom\) - var\(--space-3\) - env\(safe-area-inset-top\)\)/)
    expect(popupBlock).toMatch(/border-radius:\s*var\(--radius-xl\)/)
    expect(popupBlock).toMatch(/overflow:\s*hidden/)
    expect(popupBlock).not.toMatch(/height:\s*100dvh/)
    expect(menuHeaderBlock).toMatch(/padding:\s*var\(--space-2\) var\(--space-4\) var\(--space-4\)/)
    expect(actionsBlock).toMatch(/overflow-y:\s*auto/)
  })

  it('overlays the full close control at the menu trigger center without moving or unclipping the popup', () => {
    const headerBlock = cssBlocks(chromeCss, '.header')[0] ?? ''
    const dialogBlock = cssBlocks(chromeCss, '.menuDialog')[0] ?? ''
    const popupBlock = cssBlocks(chromeCss, '.menuPopup')[0] ?? ''
    const closeButtonBlock = cssBlocks(chromeCss, '.menuDialog > .closeButton')[0] ?? ''
    const spacerBlock = cssBlocks(chromeCss, '.menuHeaderCloseSpacer')[0] ?? ''
    const controlBlock = chromeCss.match(/\.menuButton,\s*\.closeButton\s*\{([^}]*)\}/s)?.[1] ?? ''

    expect(headerBlock).toMatch(/align-items:\s*flex-start/)
    expect(dialogBlock).toMatch(/inset:\s*0/)
    expect(dialogBlock).toMatch(/pointer-events:\s*none/)
    expect(closeButtonBlock).toMatch(/position:\s*absolute/)
    expect(closeButtonBlock).toMatch(/top:\s*var\(--workspace-chrome-control-top\)/)
    expect(closeButtonBlock).toMatch(/right:\s*var\(--workspace-chrome-control-right\)/)
    expect(closeButtonBlock).toMatch(/pointer-events:\s*auto/)
    expect(controlBlock).toMatch(/width:\s*44px/)
    expect(controlBlock).toMatch(/height:\s*44px/)
    expect(spacerBlock).toMatch(/width:\s*44px/)
    expect(spacerBlock).toMatch(/height:\s*44px/)
    expect(popupBlock).toMatch(/top:\s*calc\(var\(--space-3\) \+ env\(safe-area-inset-top\)\)/)
    expect(popupBlock).toMatch(/right:\s*calc\(var\(--space-3\) \+ env\(safe-area-inset-right\)\)/)
    expect(popupBlock).toMatch(/overflow:\s*hidden/)
    expect(popupBlock).toMatch(/pointer-events:\s*auto/)
    expect(chromeCss).toMatch(
      /--workspace-chrome-control-top:\s*calc\(var\(--space-2\) \+ env\(safe-area-inset-top\)\)/,
    )
    expect(chromeCss).toMatch(
      /--workspace-chrome-control-right:\s*calc\(var\(--space-4\) \+ env\(safe-area-inset-right\)\)/,
    )
  })

  it('keeps the mobile chrome clear of the native safe areas', () => {
    const headerBlock = cssBlocks(chromeCss, '.header').find((block) =>
      /--mobile-header-height/.test(block),
    ) ?? ''
    const bottomNavBlock = cssBlocks(chromeCss, '.bottomNav').find((block) =>
      /--mobile-bottom-nav-height/.test(block),
    ) ?? ''

    expect(headerBlock).toMatch(/min-height:\s*var\(--mobile-header-height,\s*64px\)/)
    expect(headerBlock).toMatch(/padding:\s*var\(--workspace-chrome-control-top\)/)
    expect(chromeCss).toMatch(/--workspace-chrome-control-top:\s*calc\(var\(--space-2\) \+ env\(safe-area-inset-top\)\)/)
    expect(chromeCss).toMatch(/--workspace-chrome-control-right:\s*calc\(var\(--space-4\) \+ env\(safe-area-inset-right\)\)/)
    expect(headerBlock).toMatch(/calc\(var\(--space-4\) \+ env\(safe-area-inset-left\)\)/)
    expect(bottomNavBlock).toMatch(/min-height:\s*var\(--mobile-bottom-nav-height/)
    expect(bottomNavBlock).toMatch(/height:\s*var\(--mobile-bottom-nav-height,\s*calc\(56px \+ env\(safe-area-inset-bottom\)\)\)/)
    expect(bottomNavBlock).toMatch(/calc\(var\(--space-1\) \+ env\(safe-area-inset-bottom\)\)/)
    expect(cssBlocks(chromeCss, '.bottomNav button')[0] ?? '').toMatch(/min-height:\s*44px/)
  })
})
