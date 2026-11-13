import React from 'react'
import ReactDOM from 'react-dom/client'
import '@renderer/assets/floating.css'
import {
  relayFloatingReadonlyHash,
  relayFloatingTransparentHash
} from '../../shared/relay/floating-traffic'
import { RelayFloatingApp } from './components/relay/floating-app'

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement)
// The fixed hash selects only a view. It never grants preload or Main IPC.
const transparent = window.location?.hash === `#${relayFloatingTransparentHash}`
const readonlyFloatingView =
  transparent || window.location?.hash === `#${relayFloatingReadonlyHash}`
if (readonlyFloatingView || window.relayFloatingTraffic || !window.electron?.ipcRenderer) {
  document.title = 'Relay'
  root.render(
    <React.StrictMode>
      <RelayFloatingApp transparent={transparent} />
    </React.StrictMode>
  )
} else {
  // Legacy providers call the old application IPC. Do not evaluate or mount
  // those modules in the isolated Relay readonly role.
  void Promise.all([
    import('next-themes'),
    import('@heroui/react'),
    import('./FloatingApp'),
    import('./components/base/base-error-boundary'),
    import('./hooks/use-app-config'),
    import('./hooks/use-controled-mihomo-config')
  ])
    .then(
      ([
        { ThemeProvider },
        { HeroUIProvider },
        { default: FloatingApp },
        { default: BaseErrorBoundary },
        { AppConfigProvider },
        { ControledMihomoConfigProvider }
      ]) => {
        root.render(
          <React.StrictMode>
            <HeroUIProvider>
              <ThemeProvider attribute="class" enableSystem defaultTheme="dark">
                <BaseErrorBoundary>
                  <AppConfigProvider>
                    <ControledMihomoConfigProvider>
                      <FloatingApp />
                    </ControledMihomoConfigProvider>
                  </AppConfigProvider>
                </BaseErrorBoundary>
              </ThemeProvider>
            </HeroUIProvider>
          </React.StrictMode>
        )
      }
    )
    .catch(() => {
      root.render(<p role="status">浮窗尚未载入。</p>)
    })
}
