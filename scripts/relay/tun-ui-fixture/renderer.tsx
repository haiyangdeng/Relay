import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RelayCompleteConfigurationPanel } from '../../../src/renderer/src/components/relay/complete-configuration-panel'
import { RelayTunPanel } from '../../../src/renderer/src/components/relay/tun-panel'
import type { TunSessionState } from '../../../src/shared/relay/tun'

function Fixture(): React.JSX.Element {
  const [busy, setBusy] = useState(false),
    [evidence, setEvidence] = useState<string>(),
    [tunState, setTunState] = useState<TunSessionState>(),
    [unconfirmed, setUnconfirmed] = useState(false)
  return (
    <main>
      <h1>Relay 界面隔离验证</h1>
      <p role="alert">
        以下为模拟会话，只验证真实界面组件和系统确认框。没有核心、TUN、路由或DNS操作；页面中的转发与恢复状态均为测试数据，不算实机验收。
      </p>
      <RelayCompleteConfigurationPanel
        busy={busy || !!tunState?.owned || !!tunState?.pending || unconfirmed}
        onBusy={setBusy}
        onChecked={setEvidence}
      />
      <RelayTunPanel
        busy={busy}
        onBusy={setBusy}
        completeEvidenceId={evidence}
        onState={setTunState}
        onUnconfirmed={setUnconfirmed}
      />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
