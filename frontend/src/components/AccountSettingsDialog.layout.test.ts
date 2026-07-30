import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const currentDir = dirname(fileURLToPath(import.meta.url))
const dialogCss = readFileSync(
  join(currentDir, 'AccountSettingsDialog.module.css'),
  'utf8',
)

function cssBlocks(selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...dialogCss.matchAll(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, 'g'))].map(
    (match) => match[1],
  )
}

function contrastRatio(foreground: string, background: string) {
  const luminance = (hex: string) => {
    const channels = hex
      .slice(1)
      .match(/.{2}/g)!
      .map((channel) => Number.parseInt(channel, 16) / 255)
      .map((channel) =>
        channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4,
      )
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  }
  const lighter = Math.max(luminance(foreground), luminance(background))
  const darker = Math.min(luminance(foreground), luminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

describe('AccountSettingsDialog layout contract', () => {
  it('keeps account deletion inside the safe viewport with a scrollable body', () => {
    const backdropBlock =
      cssBlocks('.confirmBackdrop').find((block) => block.includes('height: 100dvh')) ?? ''
    const dialogBlock =
      cssBlocks('.confirmDialog').find((block) => block.includes('max-height:')) ?? ''
    const bodyBlock =
      cssBlocks('.confirmBody').find((block) => block.includes('overflow-y:')) ?? ''

    expect(backdropBlock).toMatch(/height:\s*100dvh/)
    expect(backdropBlock).toMatch(/env\(safe-area-inset-top\)/)
    expect(backdropBlock).toMatch(/env\(safe-area-inset-bottom\)/)
    expect(dialogBlock).toMatch(/max-height:\s*calc\(\s*100dvh/s)
    expect(dialogBlock).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\) auto/)
    expect(bodyBlock).toMatch(/overflow-y:\s*auto/)
    expect(bodyBlock).toMatch(/overscroll-behavior:\s*contain/)
  })

  it('keeps destructive confirmation actions touch-sized', () => {
    const actionBlock = cssBlocks('.confirmActions button')[0] ?? ''

    expect(actionBlock).toMatch(/min-height:\s*44px/)
  })

  it('uses contrast-safe destructive actions and focus treatment', () => {
    const destructiveBlock = cssBlocks('.destructiveAction').find((block) =>
      block.includes('background: #991b1b'),
    ) ?? ''
    const destructiveHoverBlock = cssBlocks(
      '.destructiveAction:hover:not(:disabled)',
    )[0] ?? ''
    const inputBlock = cssBlocks('.modalInput').find((block) =>
      block.includes('border: 1px'),
    ) ?? ''
    const buttonFocusBlock = cssBlocks('.segmentedControl button:focus-visible')[0] ?? ''
    const inputFocusBlock = cssBlocks('.modalInput:focus-visible')[0] ?? ''

    expect(destructiveBlock).toMatch(/background:\s*#991b1b/)
    expect(destructiveBlock).toMatch(/color:\s*#fff/)
    expect(destructiveHoverBlock).toMatch(/background:\s*#7f1d1d/)
    expect(contrastRatio('#ffffff', '#991b1b')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio('#ffffff', '#7f1d1d')).toBeGreaterThanOrEqual(4.5)
    expect(inputBlock).toMatch(/border:\s*1px solid var\(--color-text-muted\)/)
    expect(dialogCss).toMatch(
      /\.primaryAction:focus-visible,\s*\.secondaryAction:focus-visible,\s*\.destructiveAction:focus-visible,/,
    )
    expect(buttonFocusBlock).toMatch(/outline:\s*3px solid var\(--color-primary\)/)
    expect(inputFocusBlock).toMatch(/outline:\s*3px solid var\(--color-primary\)/)
    expect(inputFocusBlock).toMatch(/border-color:\s*var\(--color-text\)/)
  })
})
