import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const currentDir = dirname(fileURLToPath(import.meta.url))
const globalCss = readFileSync(join(currentDir, '../index.css'), 'utf8')
const tripsCss = readFileSync(join(currentDir, 'TripsPage.module.css'), 'utf8')

function cssBlocks(css: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...css.matchAll(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, 'g'))].map(
    (match) => match[1],
  )
}

describe('TripsPage layout contract', () => {
  it('keeps the app background uniform without a top color band', () => {
    const bodyBlock = cssBlocks(globalCss, 'body')[0] ?? ''

    expect(bodyBlock).toMatch(/background:\s*var\(--color-bg\)/)
    expect(bodyBlock).not.toMatch(/linear-gradient/)
    expect(bodyBlock).toMatch(/min-height:\s*100dvh/)
  })

  it('uses internal page padding instead of vertical margins that force document scroll', () => {
    const shellBlock = cssBlocks(tripsCss, '.shell')[0] ?? ''
    const mobileBlock =
      [...tripsCss.matchAll(/@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*)\}\s*$/g)][0]?.[1] ??
      ''

    expect(shellBlock).toMatch(/min-height:\s*100dvh/)
    expect(shellBlock).toMatch(/margin:\s*0 auto/)
    expect(shellBlock).toMatch(/padding-block:\s*var\(--space-8\)/)
    expect(shellBlock).not.toMatch(/margin:\s*var\(--space-/)
    expect(mobileBlock).toMatch(/\.shell\s*\{[^}]*margin:\s*0 auto/s)
    expect(mobileBlock).toMatch(
      /\.shell\s*\{[^}]*padding-top:\s*calc\(var\(--space-6\) \+ env\(safe-area-inset-top\)\)/s,
    )
    expect(mobileBlock).toMatch(
      /\.shell\s*\{[^}]*padding-bottom:\s*calc\(var\(--space-6\) \+ env\(safe-area-inset-bottom\)\)/s,
    )
  })

  it('keeps the mobile account menu and trip-list action touch-sized', () => {
    const accountTriggerBlock = cssBlocks(tripsCss, '.accountMenuTrigger')[0] ?? ''
    const accountItemBlock = cssBlocks(tripsCss, '.accountMenuItem')[0] ?? ''
    const listActionBlock = cssBlocks(tripsCss, '.tripListAction')[0] ?? ''

    expect(accountTriggerBlock).toMatch(/width:\s*44px/)
    expect(accountTriggerBlock).toMatch(/min-height:\s*44px/)
    expect(accountItemBlock).toMatch(/min-height:\s*44px/)
    expect(listActionBlock).toMatch(/min-height:\s*44px/)
    expect(tripsCss).toMatch(/\.accountMenuPanel\s*\{[\s\S]*position:\s*absolute/)
  })

  it('uses a full-width trip track and an iOS-safe search font on handsets', () => {
    const mobileBlocks = cssBlocks(tripsCss, '.tripGrid')
    const searchInputBlocks = cssBlocks(tripsCss, '.searchField input')

    expect(mobileBlocks.at(-1)).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/)
    expect(searchInputBlocks.at(-1)).toMatch(/font-size:\s*var\(--font-size-base\)/)
  })
})
