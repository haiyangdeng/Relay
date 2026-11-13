import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  RELAY_WORKSPACE_PANELS,
  relayWorkspaceLink,
  type RelayWorkspacePanel
} from '@renderer/utils/relay-workspace'

// Keep drafts and in-flight operations mounted while only the selected module
// participates in layout, focus navigation and the accessibility tree.
export function RelayWorkspaceSection({
  panels,
  active,
  children
}: {
  panels: readonly RelayWorkspacePanel[]
  active: RelayWorkspacePanel
  children: ReactNode
}): React.JSX.Element {
  return (
    <div data-relay-panel={panels.join(' ')} hidden={!panels.includes(active)}>
      {children}
    </div>
  )
}

export function RelayWorkspaceTabs({
  active
}: {
  active: RelayWorkspacePanel
}): React.JSX.Element | null {
  const group = RELAY_WORKSPACE_PANELS[active].group
  const siblings = (Object.keys(RELAY_WORKSPACE_PANELS) as RelayWorkspacePanel[]).filter(
    (panel) => RELAY_WORKSPACE_PANELS[panel].group === group
  )
  if (siblings.length < 2) return null
  const primary = siblings[0]
  return (
    <nav className="relay-module-tabs" aria-label="当前模块页面">
      {active !== primary && (
        <Link to={relayWorkspaceLink(primary)}>返回{RELAY_WORKSPACE_PANELS[primary].title}</Link>
      )}
      <details className="relay-module-more" key={active}>
        <summary>更多功能</summary>
        <div role="group" aria-label="更多模块页面">
          {siblings
            .filter((panel) => panel !== active)
            .map((panel) => (
              <Link
                key={panel}
                to={relayWorkspaceLink(panel)}
                aria-current={active === panel ? 'page' : undefined}
              >
                {RELAY_WORKSPACE_PANELS[panel].title}
              </Link>
            ))}
        </div>
      </details>
    </nav>
  )
}
