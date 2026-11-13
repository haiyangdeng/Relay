import { expect, it } from 'vitest'
import { errorMessage } from './error-message'
it('shows the cause without Electron transport details and preserves useful causes', () => {
  expect(
    errorMessage(
      new Error("Error invoking remote method 'relayIsolatedProbeRun': Error: 只读观察不可用。")
    )
  ).toBe('只读观察不可用。')
  expect(errorMessage(new Error('来源已变化。'))).toBe('来源已变化。')
  expect(errorMessage(undefined, '读取失败')).toBe('读取失败')
})
