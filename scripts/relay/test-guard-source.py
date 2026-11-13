#!/usr/bin/env python3
"""Compile guard source and run injected tests; never install or activate a filter."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile

from guard_source_plan import lineage_audit_header, provider_sources, reused_observers


APP = Path(__file__).resolve().parents[2]
GUARD = APP / "native" / "guard"
TEST_NAMES = [
    "RelayGuardPolicyTests.swift",
    "RelayGuardIdentityTests.swift",
    "RelayGuardFilterSettingsTests.swift",
    "tests/RelayGuardLineageCacheTests.swift",
]
SUITES = {
    "policy": "runRelayGuardPolicySelfTests",
    "identity": "runRelayGuardIdentitySelfTests",
    "filter-settings": "runRelayGuardFilterSettingsSelfTests",
    "lineage-cache": "runRelayGuardLineageCacheSelfTests",
}


def run(command):
    result = subprocess.run(command, capture_output=True, text=True, timeout=180)
    if result.returncode:
        output = (result.stdout + result.stderr)[-12000:]
        raise RuntimeError(f"{Path(command[0]).name} {command[1]} exited {result.returncode}\n{output}")
    return result


def verify():
    if sys.platform != "darwin" or platform.machine() not in ("arm64", "x86_64"):
        raise RuntimeError("The guard source checks require a supported macOS build host.")
    report = {
        "version": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "scope": "Offline source compilation, injected identity and flow decisions only.",
        "runtimeProtectionVerified": False,
        "systemExtensionActivationAttempted": False,
        "filterPreferencesWritten": False,
        "clientOrProxyConfigurationWritten": False,
        "existingClashStoppedReloadedOrRestarted": False,
        "nativeCLIAndDesktopRuntimeEnforcementAccepted": False,
        "architectures": [],
    }
    with tempfile.TemporaryDirectory(prefix="relay-guard-source-", dir="/private/tmp") as scratch:
        scratch_path = Path(scratch)
        entrypoint = GUARD / "package/RelayGuardExtensionMain.swift"
        provider = provider_sources(APP, APP, scratch_path, reused_observers(APP, scratch_path))
        if provider.count(entrypoint) != 1:
            raise RuntimeError("The production Provider entry point was not resolved exactly once.")
        # Link the current NE implementation, but replace its entry point with
        # the fixture entry point. The binary cannot start the system extension.
        sources = [path for path in provider if path != entrypoint]
        sources += [GUARD / name for name in TEST_NAMES]
        header = lineage_audit_header(APP, APP)
        authorities = [APP / name for name in [
            "native/RelayGuardReadiness.swift",
            "native/tun/RelayTunHelperTrust.swift",
            "native/tun/RelayTunOwnedChild.swift",
            "scripts/relay/guard_source_plan.py",
            "scripts/relay/test-guard-source.py",
        ]]
        checked_sources = [*sources, header, *authorities]

        def source_hashes():
            return {
                str(path.relative_to(APP)) if path.is_relative_to(APP) else "generated/" + path.name:
                    hashlib.sha256(path.read_bytes()).hexdigest()
                for path in checked_sources
            }

        report["sourceSHA256"] = source_hashes()
        main = scratch_path / "main.swift"
        main.write_text(
            "import Darwin\n"
            "guard CommandLine.arguments.count == 2 else { exit(2) }\n"
            "switch CommandLine.arguments[1] {\n"
            + "".join(f"case {json.dumps(name)}: exit({function}())\n" for name, function in SUITES.items())
            + "default: exit(2)\n}\n"
        )
        for architecture in ("arm64", "x86_64"):
            binary = scratch_path / ("GuardSourceTests-" + architecture)
            run([
                "/usr/bin/xcrun", "swiftc", "-swift-version", "5",
                "-warnings-as-errors", "-strict-concurrency=complete",
                "-target", architecture + "-apple-macosx13.0",
                "-module-cache-path", str(scratch_path / ("ModuleCache-" + architecture)),
                "-import-objc-header", str(header), "-lbsm",
                *[str(path) for path in sources], str(main),
                "-framework", "Foundation", "-framework", "Security", "-framework", "CryptoKit",
                "-framework", "NetworkExtension", "-framework", "Network",
                "-o", str(binary),
            ])
            report["architectures"].append({
                "architecture": architecture,
                "compiled": True,
                "binarySHA256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                "runtimeTested": architecture == platform.machine(),
            })
            if architecture == platform.machine():
                lines, failures = [], []
                for suite in SUITES:
                    try:
                        lines.append(run([str(binary), suite]).stdout.strip())
                    except RuntimeError as error:
                        failures.append(str(error))
                if failures:
                    raise RuntimeError("\n".join([*lines, *failures]))
                counts = [re.fullmatch(r"PASS: (\d+) .*", line) for line in lines]
                if not all(counts):
                    raise RuntimeError("The guard suites did not report complete success.")
                report["checks"] = sum(int(result.group(1)) for result in counts)
                report["passed"] = report["checks"]
                report["suiteOutput"] = lines
        if report["sourceSHA256"] != source_hashes():
            raise RuntimeError("Guard sources changed while verification was running.")
    report["temporaryBuildDirectoryRemoved"] = not scratch_path.exists()
    report["sourceChecksPassed"] = True
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, help="Optional local JSON evidence path.")
    options = parser.parse_args()
    try:
        report = verify()
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"sourceChecksPassed": False, "error": str(error)}, ensure_ascii=False))
        return 1
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if options.report:
        options.report.write_text(rendered)
    print(rendered, end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
