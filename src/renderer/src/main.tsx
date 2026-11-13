import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { ThemeProvider as NextThemesProvider } from 'next-themes'
import { HeroUIProvider } from '@heroui/react'
import { startRenderer, platform } from '@renderer/utils/init'
import '@renderer/assets/main.css'
import 'flag-icons/css/flag-icons.min.css'
import App from '@renderer/App'
import BaseErrorBoundary from './components/base/base-error-boundary'
import { openDevTools, quitApp } from './utils/ipc'
import { AppConfigProvider } from './hooks/use-app-config'
import { ControledMihomoConfigProvider } from './hooks/use-controled-mihomo-config'
import { OverrideConfigProvider } from './hooks/use-override-config'
import { ProfileConfigProvider } from './hooks/use-profile-config'
import { PluginConfigProvider } from './hooks/use-plugin-config'
import { RulesProvider } from './hooks/use-rules'
import { GroupsProvider } from './hooks/use-groups'
import { ToastProvider } from './components/base/toast'
import { listenForTrayTrafficFrames } from './utils/tray-traffic-frame'

if (window.electron) {
  const stopTrayTrafficFrames = listenForTrayTrafficFrames()
  if (import.meta.hot) import.meta.hot.dispose(stopTrayTrafficFrames)
}

let F12Count = 0

if (!window.location.hash) {
  window.history.replaceState(null, '', '#/relay')
}

void startRenderer(
  () => {
    document.addEventListener('keydown', (e) => {
      if (platform !== 'darwin' && e.ctrlKey && e.key === 'q') {
        e.preventDefault()
        quitApp()
      }
      if (platform === 'darwin' && e.metaKey && e.key === 'q') {
        e.preventDefault()
        quitApp()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        window.close()
      }
      if (e.key === 'F12') {
        e.preventDefault()
        F12Count++
        if (F12Count >= 5) {
          openDevTools()
          F12Count = 0
        }
      }
    })
    ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
      <React.StrictMode>
        <HeroUIProvider>
          <NextThemesProvider attribute="class" enableSystem defaultTheme="system">
            <BaseErrorBoundary>
              <HashRouter>
                <AppConfigProvider>
                  <ControledMihomoConfigProvider>
                    <ProfileConfigProvider>
                      <PluginConfigProvider>
                        <OverrideConfigProvider>
                          <GroupsProvider>
                            <RulesProvider>
                              <ToastProvider>
                                <App />
                              </ToastProvider>
                            </RulesProvider>
                          </GroupsProvider>
                        </OverrideConfigProvider>
                      </PluginConfigProvider>
                    </ProfileConfigProvider>
                  </ControledMihomoConfigProvider>
                </AppConfigProvider>
              </HashRouter>
            </BaseErrorBoundary>
          </NextThemesProvider>
        </HeroUIProvider>
      </React.StrictMode>
    )
  },
  (error) => {
    console.error('Renderer initialization failed', error)
    const root = document.getElementById('root')
    if (!root) return
    const panel = document.createElement('main')
    panel.style.cssText =
      'padding:24px;font:16px system-ui;color:hsl(var(--heroui-foreground));background:hsl(var(--heroui-background))'
    panel.setAttribute('role', 'alert')
    const heading = document.createElement('h1')
    heading.textContent = 'Relay 启动失败'
    const explanation = document.createElement('p')
    explanation.textContent =
      '界面初始化未完成。请保留错误信息，使用 Relay 菜单打开开发者工具查看详情。'
    const detail = document.createElement('pre')
    detail.style.whiteSpace = 'pre-wrap'
    detail.textContent = (error instanceof Error ? error.message : String(error)).slice(0, 8192)
    panel.append(heading, explanation, detail)
    root.replaceChildren(panel)
  }
)
