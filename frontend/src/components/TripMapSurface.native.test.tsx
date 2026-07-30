import { act, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { TripMapProps } from './TripMap'
import { TripMapSurface } from './TripMapSurface.native'

const currentDir = dirname(fileURLToPath(import.meta.url))
const mapSurfaceCss = readFileSync(join(currentDir, 'TripMapSurface.native.module.css'), 'utf8')
const mapSurfaceSource = readFileSync(join(currentDir, 'TripMapSurface.native.tsx'), 'utf8')

describe('<TripMapSurface> native target', () => {
  it('renders the native map host without importing the browser renderer', async () => {
    await act(async () => {
      render(<TripMapSurface {...({ activities: [], destination: null } as TripMapProps)} />)
    })

    expect(screen.getByTestId('native-google-map')).toBeInTheDocument()
    expect(screen.getByTestId('native-map-runtime-notice'))
      .toBeInTheDocument()
    expect(mapSurfaceSource).not.toMatch(/@vis\.gl\/react-google-maps/)
  })

  it('fills the bounded mobile map panel and supports Android native transparency', () => {
    expect(mapSurfaceCss).toMatch(/height:\s*100%/)
    expect(mapSurfaceCss).toMatch(/min-height:\s*0/)
    expect(mapSurfaceCss).toMatch(/var\(--mobile-bottom-nav-height,\s*64px\)/)
    expect(mapSurfaceCss).toMatch(/html\.native-map-active/)
  })
})
