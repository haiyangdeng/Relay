"""Deterministic shared source closure, not an executable Provider fixture."""
from pathlib import Path
import hashlib


def resolve(app, source, relative):
    private = source / relative
    return private if private.is_file() else app / relative


def reused_observers(app, output):
    trust = (app / 'native/tun/RelayTunHelperTrust.swift').read_text()
    child = (app / 'native/tun/RelayTunOwnedChild.swift').read_text()
    decoder = trust[trust.index('enum RelayTunHelperFailure:'):trust.index('enum RelayTunInstallationPaths {')]
    listener = child[child.index('enum RelayTunTCPListener {'):]
    assert listener.rstrip().endswith('}')
    target = output / 'RelayGuardReusedObservers.swift'
    target.write_text('import Foundation\nimport Darwin\n' + decoder + listener)
    return target


def lineage_audit_header(app, source):
    # Pure libbsm accessors, shared with NE. This header never imports ES.
    path = resolve(app, source, 'native/guard/lineage/RelayGuardESAudit.h')
    assert path.is_file()
    return path


def lineage_shared_sources(app, source):
    paths = [resolve(app, source, 'native/guard/lineage/' + name) for name in [
        'RelayGuardProcessGeneration.swift', 'RelayGuardLineageRelease.swift',
        'RelayGuardLineageWire.swift', 'RelayGuardLineageIdentity.swift']]
    assert all(p.is_file() for p in paths)
    return paths


def lineage_sources(app, source, output):
    # An independent ES executable: never include General/NE/Host entrypoints.
    readiness = resolve(app, source, 'native/RelayGuardReadiness.swift').read_text()
    start = readiness.index('enum RelayGuardContract {')
    end = readiness.index('\n}', start) + 2
    contract = output / 'RelayGuardLineageContract.swift'
    contract.write_text('import Foundation\n' + readiness[start:end] + '\n')
    trust = resolve(app, source, 'native/tun/RelayTunHelperTrust.swift').read_text()
    decoder = output / 'RelayGuardLineageStrictJSON.swift'
    decoder.write_text('import Foundation\n' + trust[trust.index('enum RelayTunHelperFailure:'):trust.index('enum RelayTunInstallationPaths {')])
    paths = [resolve(app, source, 'native/RelayGuardRelease.swift'), contract, decoder]
    paths += [resolve(app, source, 'native/guard/' + name) for name in
              ['RelayGuardPolicy.swift', 'RelayGuardIdentity.swift']]
    paths += lineage_shared_sources(app, source)
    paths += [resolve(app, source, 'native/guard/lineage/' + name) for name in [
        'RelayGuardKnownLineage.swift', 'RelayGuardESObservation.swift', 'RelayGuardOfficialScript.swift',
        'RelayGuardESMonitor.swift', 'RelayGuardESAuthorization.swift', 'RelayGuardExecNativeIdentity.swift', 'RelayGuardLineageServer.swift',
        'RelayGuardLineageMain.swift']]
    assert all(p.is_file() for p in paths)
    return paths


def provider_sources(app, source, output, reuse):
    readiness = (app / 'native/RelayGuardReadiness.swift').read_text()
    start = readiness.index('enum RelayGuardContract {')
    end = readiness.index('\n}', start) + 2
    contract = output / 'RelayGuardContract.swift'
    contract.write_text('import Foundation\n' + readiness[start:end] + '\n')
    paths = [resolve(app, source, 'native/RelayGuardRelease.swift'), contract, reuse]
    paths += [resolve(app, source, 'native/guard/' + name) for name in
              ['RelayGuardPolicy.swift', 'RelayGuardIdentity.swift', 'RelayGuardFilterDataProvider.swift']]
    paths += sorted((source / 'native/guard/communication').glob('*.swift'))
    paths = [p for p in paths if p.name != 'RelayGuardHostConnection.swift']
    paths += lineage_shared_sources(app, source)
    paths += [resolve(app, source, 'native/guard/package/RelayGuardExtensionMain.swift')]
    assert all(p.is_file() for p in paths)
    return paths


def terminal_sources(app, source, *, host):
    # Shared lease transport plus exactly one side. Never link the Terminal
    # executable entry into the addon, NE or ES closure.
    names = ['RelayTerminalLeaseWire.swift', 'RelayTerminalLeaseSocket.swift']
    if host:
        names.append('RelayTerminalLeaseHost.swift')
    else:
        names += ['RelayTerminalLeaseClient.swift', 'RelayTerminalLauncher.swift',
                  'RelayTerminalCLIResources.swift', 'RelayTerminalCLISession.swift', 'RelayTerminalCLIMain.swift']
    paths = [resolve(app, source, 'native/guard/terminal/' + name) for name in names]
    if not all(path.is_file() for path in paths):
        raise ValueError('Incomplete Terminal CLI source closure.')
    return paths
