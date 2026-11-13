import { useTheme } from 'next-themes'
import { Suspense, lazy, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { NavigateFunction, useLocation, useNavigate, useRoutes } from 'react-router-dom'
import OutboundModeSwitcher from '@renderer/components/sider/outbound-mode-switcher'
import { Button, Divider, Modal, ModalBody, ModalContent, ModalHeader } from '@heroui/react'
import { IoArrowForward, IoHomeOutline, IoSettings } from 'react-icons/io5'
import { toast } from '@renderer/components/base/toast'
import routes, { useDeferredRoutePreload } from '@renderer/routes'
import UpdaterButton from '@renderer/components/updater/updater-button'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import {
  applyTheme,
  setNativeTheme,
  setOperationMode,
  setTitleBarOverlay
} from '@renderer/utils/ipc'
import { platform } from '@renderer/utils/init'
import { TitleBarOverlayOptions } from 'electron'
import { useTrafficLogger } from '@renderer/hooks/use-traffic-logger'
import { useDnsOverrideAutoDisabledNotice } from '@renderer/hooks/use-dns-override-notice'
import { createTourDriver, getDriver } from '@renderer/utils/tour'
import { hasPendingPluginFile, subscribePluginFile } from '@renderer/utils/plugin-file-open'
import 'driver.js/dist/driver.css'
import { useTranslation } from 'react-i18next'
import { DEFAULT_ENABLE_TRAFFIC_LOGGER } from '../../shared/appConfig'
import SiderItem from './components/sider/sider-item'
import relayIcon from './assets/relay-icon.png'
import { getSiderCardByPath } from './utils/sider'
import {
  isRelayNavigationActive,
  relayNavigationTarget,
  RELAY_WORKSPACE_ROUTES
} from './utils/relay-workspace'
import { markInitialContentPartReady } from './utils/startup'
import {
  RELAY_PREVIEW_ONLY,
  RelayPreviewControls,
  RelayPreviewPage,
  RelayProxyRecoveryNotice
} from './components/relay/preview-controls'

export { getDriver }

const siderHoverOpenDelay = 1000
const siderHoverCloseDelay = 400

const siderCardsPromise = import('@renderer/components/sider/sider-cards')
const SiderCards = lazy(() => siderCardsPromise)
/* eslint-disable react/prop-types */

const ModeSelection: React.FC<{ onSelect: (mode: 'standard' | 'simple') => Promise<void> }> = ({
  onSelect
}) => {
  const { t, i18n } = useTranslation()
  const [selectingMode, setSelectingMode] = useState<'standard' | 'simple' | null>(null)
  const selecting = useRef(false)
  return (
    <Modal
      isOpen
      hideCloseButton
      isDismissable={false}
      isKeyboardDismissDisabled
      size="lg"
      scrollBehavior="inside"
    >
      <ModalContent dir={i18n.dir()}>
        {(close) => (
          <>
            <ModalHeader className="px-6 pt-6 pb-2 text-xl leading-snug wrap-break-word">
              {t('settings.operationMode.select.title')}
            </ModalHeader>
            <ModalBody className="gap-5 px-6 pt-0 pb-6">
              <p className="text-small leading-relaxed text-default-500">
                {t('settings.operationMode.select.description')}
              </p>
              <div className="flex shrink-0 flex-col gap-3" aria-busy={selectingMode !== null}>
                {(['standard', 'simple'] as const).map((mode) => (
                  <Button
                    key={mode}
                    variant="flat"
                    color={mode === 'simple' ? 'primary' : 'default'}
                    className="h-auto min-h-24 w-full min-w-0 shrink-0 justify-start gap-4 border border-default-200 px-4 py-4 whitespace-normal"
                    aria-labelledby={`operation-mode-${mode}-label`}
                    aria-describedby={`operation-mode-${mode}-description`}
                    isDisabled={selectingMode !== null}
                    isLoading={selectingMode === mode}
                    onPress={async () => {
                      if (selecting.current) return
                      selecting.current = true
                      setSelectingMode(mode)
                      try {
                        await onSelect(mode)
                        close()
                      } catch (error) {
                        toast.error(String(error), t('settings.operationMode.error'))
                      } finally {
                        selecting.current = false
                        setSelectingMode(null)
                      }
                    }}
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-1.5 text-start wrap-break-word">
                      <span id={`operation-mode-${mode}-label`} className="text-base font-semibold">
                        {t(`settings.operationMode.${mode}.label`)}
                      </span>
                      <span
                        id={`operation-mode-${mode}-description`}
                        className="text-small leading-relaxed text-foreground-500"
                      >
                        {t(`settings.operationMode.${mode}.description`)}
                      </span>
                    </span>
                    <IoArrowForward
                      aria-hidden="true"
                      className="shrink-0 text-lg rtl:rotate-180"
                    />
                  </Button>
                ))}
              </div>
              <p className="border-t border-default-200 pt-4 text-small leading-relaxed text-pretty text-default-500 wrap-break-word">
                {t('settings.operationMode.select.note')}
              </p>
            </ModalBody>
          </>
        )}
      </ModalContent>
    </Modal>
  )
}

const FirstContentReady: React.FC = () => {
  const { appConfig } = useAppConfig()
  const location = useLocation()
  const sent = useRef(false)

  useEffect(() => {
    const ready = Boolean(appConfig) && location.pathname !== '/'
    if (!ready || sent.current) return
    sent.current = true
    if (RELAY_PREVIEW_ONLY) markInitialContentPartReady('sider')
    markInitialContentPartReady('route')
  }, [appConfig, location.pathname])

  return null
}

const App: React.FC = () => {
  const { t, ready, i18n } = useTranslation()
  const { appConfig, patchAppConfig } = useAppConfig()
  const hasAppConfig = Boolean(appConfig)
  const {
    enableTrafficLogger = DEFAULT_ENABLE_TRAFFIC_LOGGER,
    appTheme = 'system',
    customTheme,
    useWindowFrame = false,
    siderWidth = 250,
    disableAnimations = false,
    lastSelectedSiderCard = 'proxy',
    rememberSelectedSiderCard = false
  } = appConfig || {}
  useTrafficLogger(!RELAY_PREVIEW_ONLY && hasAppConfig && enableTrafficLogger)
  useEffect(() => {
    if (!hasAppConfig || !appConfig?.language || appConfig.language === i18n.language) return
    void i18n.changeLanguage(appConfig.language).catch(() => {
      console.warn('界面语言尚未应用，请重新读取偏好。')
    })
  }, [hasAppConfig, appConfig?.language, i18n])
  useDnsOverrideAutoDisabledNotice()
  const narrowWidth = platform === 'darwin' ? 70 : 60
  const [siderWidthValue, setSiderWidthValue] = useState(siderWidth)
  const siderWidthValueRef = useRef(siderWidthValue)
  const [resizing, setResizing] = useState(false)
  const resizingRef = useRef(resizing)
  const [siderHovered, setSiderHovered] = useState(false)
  const siderHoverTimerRef = useRef<number | undefined>(undefined)
  const siderPointerInsideRef = useRef(false)
  const siderCollapsed = siderWidthValue === narrowWidth
  const siderExpandedOnHover = siderCollapsed && siderHovered && !resizing
  const displayedSiderWidth = siderExpandedOnHover ? narrowWidth + 120 : siderWidthValue

  const scheduleSiderHover = (expanded: boolean): void => {
    window.clearTimeout(siderHoverTimerRef.current)
    siderHoverTimerRef.current = window.setTimeout(
      () => setSiderHovered(expanded),
      expanded ? siderHoverOpenDelay : siderHoverCloseDelay
    )
  }

  const resetSiderHoverTimer = (): void => {
    if (!siderCollapsed || resizing) return
    if (siderPointerInsideRef.current === siderExpandedOnHover) {
      window.clearTimeout(siderHoverTimerRef.current)
    } else {
      scheduleSiderHover(siderPointerInsideRef.current)
    }
  }
  useDeferredRoutePreload(RELAY_PREVIEW_ONLY)
  const { setTheme, systemTheme } = useTheme()
  const navigate: NavigateFunction = useNavigate()
  const location = useLocation()
  const page = useRoutes(routes)

  useEffect(() => {
    const openPluginImport = (): void => {
      navigate(RELAY_PREVIEW_ONLY ? relayNavigationTarget('/profiles') : '/profiles')
    }
    const unsubscribe = subscribePluginFile(openPluginImport)
    if (hasPendingPluginFile()) openPluginImport()
    return unsubscribe
  }, [navigate])

  const setTitlebar = useCallback((): void => {
    if (!useWindowFrame && platform !== 'darwin') {
      const options = { height: 47 } as TitleBarOverlayOptions
      try {
        options.color = window.getComputedStyle(document.documentElement).backgroundColor
        options.symbolColor = window.getComputedStyle(document.documentElement).color
        setTitleBarOverlay(options)
      } catch {
        // ignore
      }
    }
  }, [useWindowFrame])

  useEffect(() => {
    setSiderWidthValue(siderWidth)
  }, [siderWidth])

  useEffect(() => {
    if (!hasAppConfig) return
    if (!rememberSelectedSiderCard) return
    const selectedRoute =
      RELAY_PREVIEW_ONLY && location.pathname === '/relay'
        ? Object.keys(RELAY_WORKSPACE_ROUTES).find((route) =>
            isRelayNavigationActive(location.pathname, location.search, route)
          )
        : location.pathname
    const currentSiderCard = getSiderCardByPath(selectedRoute ?? '')
    if (!currentSiderCard || currentSiderCard === lastSelectedSiderCard) return
    patchAppConfig({ lastSelectedSiderCard: currentSiderCard })
  }, [
    hasAppConfig,
    rememberSelectedSiderCard,
    lastSelectedSiderCard,
    location.pathname,
    location.search,
    patchAppConfig
  ])

  useEffect(() => {
    siderWidthValueRef.current = siderWidthValue
    resizingRef.current = resizing
  }, [siderWidthValue, resizing])

  useEffect(() => {
    window.clearTimeout(siderHoverTimerRef.current)
    setSiderHovered(false)
    return (): void => window.clearTimeout(siderHoverTimerRef.current)
  }, [siderCollapsed, resizing])

  const onResizeEnd = useCallback((): void => {
    if (resizingRef.current) {
      setResizing(false)
      patchAppConfig({ siderWidth: siderWidthValueRef.current })
    }
  }, [patchAppConfig])

  useEffect(() => {
    if (!ready || !hasAppConfig || !appConfig?.modeSelected) return
    createTourDriver(t, navigate)
    // Relay preview explains its locked state in the workspace; do not auto-run
    // the upstream tour that prompts users to configure a live network.
  }, [t, ready, navigate, hasAppConfig, appConfig?.modeSelected])

  useEffect(() => {
    setNativeTheme(appTheme)
    setTheme(appTheme)
    setTitlebar()
  }, [appTheme, systemTheme, setTheme, setTitlebar])

  useEffect(() => {
    applyTheme(customTheme || 'default.css').then(() => {
      setTitlebar()
    })
  }, [customTheme, setTitlebar])

  useEffect(() => {
    window.addEventListener('mouseup', onResizeEnd)
    return (): void => window.removeEventListener('mouseup', onResizeEnd)
  }, [onResizeEnd])

  if (hasAppConfig && !appConfig?.modeSelected) {
    return (
      <ModeSelection
        onSelect={async (mode) => {
          await setOperationMode(mode)
        }}
      />
    )
  }

  return (
    <div
      onMouseMove={(e) => {
        if (!resizing) return
        if (e.clientX <= 150) {
          setSiderWidthValue(narrowWidth)
        } else if (e.clientX <= 250) {
          setSiderWidthValue(250)
        } else if (e.clientX >= 400) {
          setSiderWidthValue(400)
        } else {
          setSiderWidthValue(e.clientX)
        }
      }}
      className={`relay-shell w-full h-screen flex ${resizing ? 'cursor-ew-resize' : ''}`}
    >
      <div
        style={{ width: siderWidthValue }}
        className="relative z-20 h-full shrink-0"
        onPointerEnter={(event) => {
          if (event.pointerType === 'touch' || !siderCollapsed || resizing) return
          siderPointerInsideRef.current = true
          resetSiderHoverTimer()
        }}
        onPointerLeave={() => {
          siderPointerInsideRef.current = false
          resetSiderHoverTimer()
        }}
        onPointerDownCapture={() => {
          if (siderCollapsed && !resizing) {
            window.clearTimeout(siderHoverTimerRef.current)
          }
        }}
        onPointerCancelCapture={resetSiderHoverTimer}
        onClickCapture={resetSiderHoverTimer}
      >
        {siderCollapsed ? (
          <div
            style={
              {
                width: displayedSiderWidth,
                '--sider-icon-width': `${narrowWidth - 16}px`
              } as CSSProperties
            }
            data-expanded={siderExpandedOnHover}
            data-animated={!disableAnimations && !resizing}
            className="sider-rail absolute inset-y-0 left-0 h-full flex flex-col"
          >
            <div className="side sider-rail-background" aria-hidden="true" />
            <div className="app-drag flex shrink-0 items-center z-40 bg-transparent h-11.25">
              <div style={{ width: narrowWidth }} className="flex shrink-0 justify-center">
                {platform !== 'darwin' && (
                  <img src={relayIcon} alt="Relay" className="h-8 leading-8 text-lg mx-px" />
                )}
              </div>
              <span
                className="sider-item-label text-lg font-bold"
                aria-hidden={!siderExpandedOnHover}
              >
                Relay
              </span>
            </div>
            {RELAY_PREVIEW_ONLY ? (
              <RelayPreviewControls
                iconOnly
                expanded={siderExpandedOnHover}
                clashViewsReady
                liveControls={<OutboundModeSwitcher iconOnly expanded={siderExpandedOnHover} />}
              />
            ) : (
              <Suspense fallback={<div className="min-h-0 flex-1" />}>
                <SiderCards iconOnly expanded={siderExpandedOnHover} />
              </Suspense>
            )}
            <div className="pt-2 pb-4 flex shrink-0 flex-col space-y-2">
              {!RELAY_PREVIEW_ONLY && (
                <>
                  <div className="flex justify-center">
                    <UpdaterButton iconOnly />
                  </div>
                  <div className="px-2 flex justify-center">
                    <OutboundModeSwitcher iconOnly expanded={siderExpandedOnHover} />
                  </div>
                </>
              )}
              <SiderItem
                title="概览"
                route="/relay"
                active={
                  RELAY_PREVIEW_ONLY
                    ? isRelayNavigationActive(location.pathname, location.search, '/relay')
                    : undefined
                }
                icon={<IoHomeOutline className="text-[22px]" />}
                expanded={siderExpandedOnHover}
                className="app-nodrag"
              />
              <SiderItem
                title={t('common.settings')}
                route={RELAY_PREVIEW_ONLY ? relayNavigationTarget('/settings') : '/settings'}
                active={
                  RELAY_PREVIEW_ONLY
                    ? isRelayNavigationActive(location.pathname, location.search, '/settings')
                    : undefined
                }
                icon={<IoSettings className="text-[20px]" />}
                expanded={siderExpandedOnHover}
                className="app-nodrag"
              />
            </div>
          </div>
        ) : (
          <div
            style={{ width: `${siderWidthValue}px` }}
            className="side h-full overflow-y-auto no-scrollbar"
          >
            <div className="app-drag sticky top-0 z-40 backdrop-blur bg-transparent h-12.25">
              <div
                className={`flex justify-between p-2 ${!useWindowFrame && platform === 'darwin' ? 'ml-15' : ''}`}
              >
                <div className="flex ml-1">
                  <img src={relayIcon} alt="Relay" className="h-8 leading-8 text-lg mx-px" />
                  <h3 className="text-lg font-bold leading-8">Relay</h3>
                </div>
                {!RELAY_PREVIEW_ONLY && <UpdaterButton />}
                <Button
                  size="sm"
                  className="app-nodrag"
                  isIconOnly
                  title={t('common.settings')}
                  color={
                    isRelayNavigationActive(location.pathname, location.search, '/settings')
                      ? 'primary'
                      : 'default'
                  }
                  variant={
                    isRelayNavigationActive(location.pathname, location.search, '/settings')
                      ? 'solid'
                      : 'light'
                  }
                  onPress={() => {
                    navigate(RELAY_PREVIEW_ONLY ? relayNavigationTarget('/settings') : '/settings')
                  }}
                >
                  <IoSettings className="text-[20px]" />
                </Button>
              </div>
            </div>
            <div className="mx-2 mt-2">
              <Button
                className="relay-home-button w-full"
                startContent={<IoHomeOutline size={23} aria-hidden="true" />}
                aria-current={
                  isRelayNavigationActive(location.pathname, location.search, '/relay')
                    ? 'page'
                    : undefined
                }
                color={
                  isRelayNavigationActive(location.pathname, location.search, '/relay')
                    ? 'primary'
                    : 'default'
                }
                variant="flat"
                onPress={() => navigate('/relay')}
              >
                概览
              </Button>
            </div>
            {RELAY_PREVIEW_ONLY ? (
              <RelayPreviewControls clashViewsReady liveControls={<OutboundModeSwitcher />} />
            ) : (
              <>
                <div className="mt-2 mx-2">
                  <OutboundModeSwitcher />
                </div>
                <Suspense fallback={null}>
                  <SiderCards />
                </Suspense>
              </>
            )}
          </div>
        )}
      </div>

      <div
        onMouseDown={() => {
          setResizing(true)
        }}
        style={{
          position: 'fixed',
          zIndex: 50,
          left: `${displayedSiderWidth - 2}px`,
          width: '5px',
          height: '100vh',
          cursor: 'ew-resize'
        }}
        data-animated={siderCollapsed && !disableAnimations && !resizing}
        className={`sider-resize-handle ${resizing ? 'bg-primary' : ''}`}
      />
      <Divider orientation="vertical" />
      <div
        style={{ width: `calc(100% - ${siderWidthValue + 1}px)` }}
        className="main relative z-0 grow h-full min-h-0 flex flex-col overflow-hidden"
      >
        <RelayProxyRecoveryNotice />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Suspense fallback={<div className="h-full w-full bg-content1" />}>
            {RELAY_PREVIEW_ONLY ? (
              <RelayPreviewPage path={location.pathname}>{page}</RelayPreviewPage>
            ) : (
              page
            )}
            <FirstContentReady />
          </Suspense>
        </div>
      </div>
    </div>
  )
}

export default App
