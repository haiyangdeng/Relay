import { useState } from 'react'
import BasePage from '@renderer/components/base/base-page'
import { RelaySystemProxyPanel } from '@renderer/components/relay/system-proxy-panel'
import './relay-workspace.css'

export default function RelaySystemProxyPage(): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <BasePage title="System Proxy">
      <main className="relay-workspace">
        <RelaySystemProxyPanel busy={busy} onBusy={setBusy} />
      </main>
    </BasePage>
  )
}
