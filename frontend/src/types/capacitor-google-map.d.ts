import type { ClassAttributes, HTMLAttributes } from 'react'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'capacitor-google-map': ClassAttributes<HTMLElement> & HTMLAttributes<HTMLElement>
    }
  }
}
