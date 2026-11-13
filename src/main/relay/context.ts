import { join } from 'path'

export interface RelayStateContext {
  home: string
  stateRoot: string
}
export interface RelayCodeContext extends RelayStateContext {
  browserExecutable: string
}

export interface RelayDiagnosticContext {
  home: string
  clashRoot: string
  browserProfile: string
  browserExecutable: string
}

export function relayDiagnosticContext(
  home: string,
  nativeExecutable: string,
  stateDirectory = join(home, 'Library/Application Support/Relay-Preview')
): RelayDiagnosticContext {
  return {
    home,
    clashRoot: join(home, 'Library/Application Support/mihomo-party'),
    browserProfile: join(stateDirectory, 'Private Browser'),
    browserExecutable: join(nativeExecutable, '..', 'RelayBrowser.app/Contents/MacOS/RelayBrowser')
  }
}

// Main-process-owned locations. Renderer messages never choose native binaries,
// resource paths or a writable legacy directory. No directory is created here.
export function relayRuntimeContext(input: {
  packaged: boolean
  resources: string
  mainDirectory: string
  userData: string
}): {
  nativeExecutable: string
  browserExecutable: string
  handoffDocument: string
  stateDirectory: string
} {
  const resources = input.packaged
    ? join(input.resources, 'relay')
    : join(input.mainDirectory, '../../extra/relay')
  return {
    nativeExecutable: join(resources, 'RelayNative'),
    browserExecutable: join(resources, 'RelayBrowser.app/Contents/MacOS/RelayBrowser'),
    handoffDocument: join(resources, 'docs/AI-Network-Handoff.md'),
    stateDirectory: input.userData
  }
}
