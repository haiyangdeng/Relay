import { execFile } from 'child_process'
import type { RelayBrowserLaunchResult } from '../../shared/relay/protocol'

// App button has one fixed destination; arbitrary URLs are accepted only by the
// bundled helper's validated CLI entry used by Claude Code itself.
export function openRelayBrowser(executable: string): Promise<RelayBrowserLaunchResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      ['https://claude.ai/login'],
      { timeout: 10000, maxBuffer: 131072 },
      (error) => {
        if (error) {
          reject(
            new Error(
              '专用浏览器启动未确认。请检查 Relay 的 AI 专用代理、专用资料与 Chrome 状态；没有调用默认浏览器。'
            )
          )
          return
        }
        resolve({
          status: 'requested',
          warnings: ['已向专用 Chrome 提交启动请求；实际窗口、DNS及WebRTC仍需验收。']
        })
      }
    )
    child.stdin?.on('error', () => reject(new Error('浏览器入口输入通道已关闭，请核对启动结果。')))
    child.stdin?.end()
  })
}
