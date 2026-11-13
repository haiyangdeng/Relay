async function within(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

// Only a handle held from this launch is accepted, never a PID from storage.
// A traffic-carrying instance must stay recoverable if polite shutdown fails.
export async function stopOwnedChild(
  child: { kill(signal: 'SIGTERM' | 'SIGKILL'): boolean },
  closed: Promise<void>,
  kind: 'inert' | 'localProxy'
): Promise<void> {
  child.kill('SIGTERM')
  if (await within(closed, 3000)) return
  if (kind === 'localProxy') throw new Error('本次代理仍未退出，保留实例和记录；未强制结束。')
  child.kill('SIGKILL')
  if (!(await within(closed, 2000))) throw new Error('隔离子进程退出未确认，保留目录。')
}
