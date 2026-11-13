import { describe, expect, it, vi } from 'vitest'
import { createSimpleEditorScope } from './simple-scope'

function fixture() {
  let visible = true
  const invalidated = new Set<() => void>(),
    restored = new Set<() => void>(),
    visibility = new Set<() => void>()
  const subscribe = (listeners: Set<() => void>) =>
    vi.fn((listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    })
  const environment = {
    isVisible: () => visible,
    onInvalidated: subscribe(invalidated),
    onRestored: subscribe(restored),
    onVisibilityChanged: subscribe(visibility)
  }
  const scope = createSimpleEditorScope(environment)
  return {
    scope,
    environment,
    invalidated,
    restored,
    visibility,
    hide: () => {
      visible = false
    },
    show: () => {
      visible = true
    }
  }
}
describe('Mounted Simple editor scope and existing no-body events', () => {
  it('is not current and installs no listeners before an editor subscribes', () => {
    const f = fixture()
    expect(f.scope.isCurrent()).toBe(false)
    expect(f.environment.onInvalidated).not.toHaveBeenCalled()
  })
  it('forwards invalidation and restore, then disconnects every source on detach', () => {
    const f = fixture(),
      listener = vi.fn(),
      remove = f.scope.subscribeInvalidation(listener)
    f.invalidated.forEach((call) => call())
    f.restored.forEach((call) => call())
    expect(listener).toHaveBeenCalledTimes(2)
    remove()
    expect(f.scope.isCurrent()).toBe(false)
    expect(f.invalidated.size + f.restored.size + f.visibility.size).toBe(0)
  })
  it('invalidates on hidden visibility but does not issue work when visibility returns', () => {
    const f = fixture(),
      listener = vi.fn(),
      remove = f.scope.subscribeInvalidation(listener)
    f.hide()
    f.visibility.forEach((call) => call())
    expect(f.scope.isCurrent()).toBe(false)
    expect(listener).toHaveBeenCalledOnce()
    f.show()
    f.visibility.forEach((call) => call())
    expect(f.scope.isCurrent()).toBe(true)
    expect(listener).toHaveBeenCalledOnce()
    remove()
  })
  it('supports StrictMode detach/reconnect without delivering events to the old subscriber', () => {
    const f = fixture(),
      first = vi.fn(),
      removeFirst = f.scope.subscribeInvalidation(first)
    removeFirst()
    const second = vi.fn(),
      removeSecond = f.scope.subscribeInvalidation(second)
    f.invalidated.forEach((call) => call())
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
    removeSecond()
    expect(f.scope.isCurrent()).toBe(false)
  })
  it('fails closed and removes already-installed listeners if a later registration fails', () => {
    const f = fixture(),
      listener = vi.fn()
    f.environment.onRestored.mockImplementationOnce(() => {
      throw new Error('Context destroyed')
    })
    const remove = f.scope.subscribeInvalidation(listener)
    expect(f.scope.isCurrent()).toBe(false)
    expect(f.invalidated.size).toBe(0)
    expect(listener).toHaveBeenCalledOnce()
    remove()
  })
})
