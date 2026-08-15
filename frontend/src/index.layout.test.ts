import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const currentDir = dirname(fileURLToPath(import.meta.url))
const globalCss = readFileSync(join(currentDir, 'index.css'), 'utf8')
const documentHtml = readFileSync(join(currentDir, '../index.html'), 'utf8')
const mobileBlock =
  globalCss.match(/@media\s*\(max-width:\s*820px\)\s*\{([\s\S]*?)\}\s*(?=h1,)/i)?.[1] ?? ''

describe('global mobile input typography contract', () => {
  it('keeps editable controls at an iOS-safe minimum on handset widths', () => {
    expect(mobileBlock).toMatch(
      /#root\s+input(?:\s*:not\(\[type='[^']+'\]\))+\s*,\s*#root textarea\s*,\s*#root select\s*\{[\s\S]*font-size:\s*max\(16px,\s*1em\)\s*!important/i,
    )
  })

  it('excludes non-text controls and leaves pinch zoom enabled', () => {
    for (const type of ['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']) {
      expect(mobileBlock).toContain(`:not([type='${type}'])`)
    }

    expect(globalCss).not.toMatch(/maximum-scale|user-scalable\s*=\s*no/i)
    expect(documentHtml).not.toMatch(/maximum-scale|user-scalable\s*=\s*no/i)
  })
})
