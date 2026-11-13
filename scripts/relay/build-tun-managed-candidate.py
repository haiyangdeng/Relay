#!/usr/bin/env python3
"""Prepare a separate core-managed payload/package. Never install or execute it."""
import ast
import argparse
import datetime
import importlib.util
import json
import os
from pathlib import Path
import sys
import subprocess
import uuid

APP = Path(__file__).resolve().parents[2]
ROOT = "/Library/Application Support/Relay/TunManaged"
RECEIPT = "local.relay.network.tun.core-managed-v1"
LOCK = b"Relay core-managed TUN v1\n"

UNINSTALL = r'''#!/usr/bin/python3
import fcntl, hashlib, json, os, stat, subprocess, sys
from pathlib import Path
ROOT = Path("/Library/Application Support/Relay/TunManaged")
RECEIPT = "local.relay.network.tun.core-managed-v1"
def checked(path, mode):
    for parent in path.parents:
        s = parent.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o6022:
            raise RuntimeError("Unsafe installation ancestor")
    fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or stat.S_IMODE(before.st_mode) != mode or before.st_nlink != 1:
            raise RuntimeError("Unsafe installation file")
        data = bytearray()
        while True:
            block = os.read(fd, 65536)
            if not block: break
            data.extend(block)
            if len(data) > 134217728: raise RuntimeError("Oversized file")
        after, linked = os.fstat(fd), path.lstat()
        fields = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if fields(before) != fields(after) or fields(after) != fields(linked):
            raise RuntimeError("Installation changed during inspection")
        return bytes(data), after
    finally: os.close(fd)
def digest(data): return hashlib.sha256(data).hexdigest()
def main():
    if os.getuid() != 0 or os.geteuid() != 0 or len(sys.argv) != 3 or sys.argv[1] != "--remove":
        raise RuntimeError("Requires an explicitly authorized root removal and manifest SHA256")
    if Path(sys.argv[0]).absolute() != ROOT / "uninstall.py": raise RuntimeError("Wrong entry")
    manifest_bytes, _ = checked(ROOT / "installation.json", 0o644)
    if digest(manifest_bytes) != sys.argv[2]: raise RuntimeError("Manifest identity mismatch")
    m = json.loads(manifest_bytes)
    if m.get("version") != 1 or m.get("role") != "core-managed-v1": raise RuntimeError("Wrong role")
    lock_bytes, lock_identity = checked(ROOT / "busy.lock", 0o644)
    if lock_bytes != b"Relay core-managed TUN v1\n": raise RuntimeError("Wrong lock")
    lock = os.open(str(ROOT / "busy.lock"), os.O_RDONLY | os.O_NOFOLLOW)
    try:
        held = os.fstat(lock)
        if (held.st_dev, held.st_ino) != (lock_identity.st_dev, lock_identity.st_ino): raise RuntimeError("Lock changed")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        expected = {
            "RelayTunClient": (m["client"]["sha256"], 0o755),
            "installation.json": (sys.argv[2], 0o644),
            "busy.lock": (digest(lock_bytes), 0o644),
            "uninstall.py": (m["uninstallerSHA256"], 0o755),
            "Core/darwin-arm64/mihomo": (m["cores"]["arm64"]["sha256"], 0o4755),
            "Core/darwin-x64/mihomo": (m["cores"]["x86_64"]["sha256"], 0o4755),
        }
        directories = ["Core/darwin-arm64", "Core/darwin-x64", "Core"]
        if {str(p.relative_to(ROOT)) for p in ROOT.rglob("*")} != set(expected) | set(directories):
            raise RuntimeError("Unknown installation content; nothing removed")
        snapshots = {}
        for name, (sha, mode) in expected.items():
            content, info = checked(ROOT / name, mode)
            if digest(content) != sha: raise RuntimeError("Changed installed resource; nothing removed")
            snapshots[name] = (info.st_dev, info.st_ino)
        lock_fields = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid, s.st_nlink,
                                 s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        current_lock, linked_lock = os.fstat(lock), (ROOT / "busy.lock").lstat()
        if (lock_fields(current_lock) != lock_fields(held) or lock_fields(current_lock) != lock_fields(linked_lock)
                or snapshots["busy.lock"] != (held.st_dev, held.st_ino)):
            raise RuntimeError("Lifetime lock changed; nothing removed")
        # Remove admission first while the exact inherited lifetime lock is held.
        # No signal, service stop, route/DNS command or recursive removal exists.
        for name in ["installation.json", "RelayTunClient", "Core/darwin-arm64/mihomo", "Core/darwin-x64/mihomo", "uninstall.py", "busy.lock"]:
            info = (ROOT / name).lstat()
            if (info.st_dev, info.st_ino) != snapshots[name]: raise RuntimeError("Resource replaced; removal stopped")
            (ROOT / name).unlink()
        for name in directories: (ROOT / name).rmdir()
        ROOT.rmdir()
        subprocess.run(["/usr/sbin/pkgutil", "--forget", RECEIPT], check=True, timeout=30)
        print(json.dumps({"removed": True, "networkModified": False, "processesStopped": False}))
    finally: os.close(lock)
if __name__ == "__main__": main()
'''

PREINSTALL = r'''#!/usr/bin/python3
import os, stat, sys
from pathlib import Path
if os.geteuid() != 0 or len(sys.argv) < 4 or sys.argv[3] != "/":
    raise SystemExit("Only a separately authorized installation on the startup volume is supported")
for name in ["/Library/Application Support/Relay/Tun", "/Library/Application Support/Relay/TunManaged"]:
    if os.path.lexists(name):
        raise SystemExit("Existing Relay TUN installation remains; no replacement or recovery will be attempted")
for name in ["/", "/Library", "/Library/Application Support", "/Library/Application Support/Relay"]:
    p = Path(name)
    if not os.path.lexists(p): continue
    s = p.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o6022:
        raise SystemExit("Unsafe installation parent")
'''

def uninstaller_for_profile(profile=None):
    if profile is None: return UNINSTALL
    if profile not in ['stable', 'alpha', 'smart', 'local-geodata-v1']:
        raise RuntimeError('Unknown fixed execution profile')
    old = 'm.get("version") != 1 or m.get("role") != "core-managed-v1"'
    if UNINSTALL.count(old) != 1: raise RuntimeError('Uninstaller role gate changed')
    return UNINSTALL.replace(old, 'm.get("version") != 2 or m.get("role") != "core-managed-v2"').replace(
        'local.relay.network.tun.core-managed-v1', 'local.relay.network.tun.core-managed-v2')



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execution-profile', choices=['stable', 'alpha', 'smart', 'local-geodata-v1'])
    parser.add_argument('--execution-core-root', type=Path)
    args = parser.parse_args()
    if os.getuid() <= 0 or os.geteuid() != os.getuid():
        raise RuntimeError("Offline preparation only; no root or installation arguments")
    if bool(args.execution_core_root) != (args.execution_profile in ['alpha', 'smart']):
        raise RuntimeError("Only Alpha/Smart preparation requires an explicit private fixed Core root")
    if args.execution_core_root and not args.execution_core_root.is_absolute():
        raise RuntimeError("Private fixed Core input must be an absolute path")
    if args.execution_core_root:
        if args.execution_core_root.resolve(strict=True) != args.execution_core_root:
            raise RuntimeError('Private fixed Core input must be canonical')
        args.execution_core_root.relative_to(APP)
    subprocess.run(["/usr/bin/python3", "-I", "-B", str(APP / "scripts/relay/test-tun-managed-uninstall.py")], check=True)
    spec = importlib.util.spec_from_file_location("relay_package_tools", APP / "scripts/relay/build-tun-candidate.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    compiled = Path(os.environ.get("RELAY_TUN_HELPER_BUILD_DIR", str(APP / ".relay-build/tun-helper")))
    if not compiled.is_absolute(): raise RuntimeError("Compiled helper input must be an absolute path")
    snapshot = json.loads((compiled / "shipping-sources.json").read_text())
    required = {"native/tun/RelayTunManagedCore.swift", "native/tun/RelayTunAppSession.swift", "native/tun/RelayTunClientMain.swift", "native/tun/RelayTunHelperTrust.swift", "native/tun/RelayTunRuntimeResources.swift", "native/tun/RelayTunRuntimeResourceInbox.swift", "native/tun/RelayTunRuntimeResourcesChannel.swift", "native/tun/RelayTunRuntimeAssetChannel.swift", "native/tun/RelayTunRuntimeRuleProviders.swift", "native/tun/RelayTunRuntimeRuleProviderFiles.swift", "native/tun/RelayTunRuntimeRuleProviderProbe.swift", "native/tun/RelayTunRuleProviderProbeWorkspace.swift", "native/tun/RelayTunRuntimeRuleProvidersChannel.swift"}
    if args.execution_profile:
        required.update({"native/tun/RelayTunExecutionReceiptV2.swift", "native/tun/RelayTunExecutionInstallationV2.swift",
                         "native/tun/RelayTunSmartStateCodec.swift", "native/tun/RelayTunSmartState.swift",
                         "native/tun/RelayTunSmartStateChannel.swift"})
    if not required.issubset(snapshot["files"]): raise RuntimeError("Managed client has not been compiled")
    for name, sha in snapshot["files"].items():
        if module.sha(APP / name) != sha: raise RuntimeError("Shipping source changed; rebuild before packaging: " + name)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    candidate = APP / ".relay-build" / ("tun-managed-candidate-" + stamp + "-" + uuid.uuid4().hex[:8])
    candidate.mkdir(mode=0o700)
    payload = candidate / "payload"
    installed = payload / ROOT.lstrip("/")
    installed.mkdir(parents=True, mode=0o755)
    module.copy_source(compiled / "RelayTunClient", installed / "RelayTunClient", 0o755)
    pin = module.code_pin(installed / "RelayTunClient")
    profile = json.loads((APP / "src/main/relay/core/geodata-manifest.json").read_text())
    if profile["version"] != "relay-geodata-v1p1-3f27" or profile["capability"] != "local-geodata-v1":
        raise RuntimeError("Unknown Geo Core profile")
    core_profile = args.execution_profile or 'local-geodata-v1'
    core_root = APP / 'extra/relay/core-geodata-v1'
    if core_profile == 'stable':
        profile = json.loads((APP / 'src/main/relay/core/manifest.json').read_text())
        core_root = APP / 'extra/relay/core'
    elif core_profile in ['alpha', 'smart']:
        catalog = json.loads((APP / 'src/main/relay/core/variants-manifest.json').read_text())
        profiles = [entry for entry in catalog['cores'] if entry['family'] == core_profile]
        if len(profiles) != 1: raise RuntimeError('Unknown fixed execution profile')
        profile = profiles[0]
        core_root = args.execution_core_root
    for arch, source_arch in [("arm64", "arm64"), ("x86_64", "x64")]:
        original = APP / "extra/relay/core" / ("darwin-" + source_arch) / "mihomo"
        original_sha, original_size = module.CORE_PINS[arch]
        if module.sha(original) != original_sha or original.stat().st_size != original_size:
            raise RuntimeError("Original official Core fallback changed")
    cores = {}
    for arch, source_arch in [("arm64", "arm64"), ("x86_64", "x64")]:
        destination = installed / "Core" / ("darwin-" + source_arch) / "mihomo"
        source = profile["assets"][source_arch]
        if source["path"] != "darwin-" + source_arch + "/mihomo" or source["cpuType"] != (0x100000c if source_arch == "arm64" else 0x1000007):
            raise RuntimeError("Wrong Geo Core architecture")
        module.copy_source(core_root / source["path"], destination, 0o4755)
        sha, size = source["sha256"], source["size"]
        if module.sha(destination) != sha or destination.stat().st_size != size: raise RuntimeError("Fixed core changed")
        cores[arch] = {"sha256": sha, "size": size}
    role = 'core-managed-v2' if args.execution_profile else 'core-managed-v1'
    version = 2 if args.execution_profile else 1
    receipt = RECEIPT.replace('core-managed-v1', role)
    uninstall_source = uninstaller_for_profile(args.execution_profile)
    ast.parse(uninstall_source, feature_version=(3, 9)); ast.parse(PREINSTALL, feature_version=(3, 9))
    uninstaller = installed / "uninstall.py"
    uninstaller.write_text(uninstall_source); uninstaller.chmod(0o755)
    (installed / "busy.lock").write_bytes(LOCK); (installed / "busy.lock").chmod(0o644)
    manifest = {"version": version, "role": role, "coreProfile": core_profile, "clientUID": os.getuid(), "client": pin,
                "cores": cores, "uninstallerSHA256": module.sha(uninstaller)}
    manifest_path = installed / "installation.json"
    manifest_path.write_text(json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n"); manifest_path.chmod(0o644)
    for directory in [payload, *[p for p in payload.rglob("*") if p.is_dir()]]: directory.chmod(0o755)
    scripts = candidate / "scripts"; scripts.mkdir(mode=0o755)
    (scripts / "preinstall").write_text(PREINSTALL); (scripts / "preinstall").chmod(0o755)
    package = candidate / ('RelayTun-CoreManaged-' + ('v2-' + core_profile if args.execution_profile else 'v1') + '.pkg')
    module.run(["/usr/bin/pkgbuild", "--root", str(payload), "--scripts", str(scripts), "--identifier", receipt,
                "--version", "0.34.0" if args.execution_profile else "0.33.0", "--install-location", "/", "--ownership", "recommended", str(package)])
    expanded = candidate / "expanded"
    module.run(["/usr/sbin/pkgutil", "--expand-full", str(package), str(expanded)])
    extracted = expanded / "Payload" / ROOT.lstrip("/")
    expected = {str(p.relative_to(installed)): {"sha256": module.sha(p), "mode": p.stat().st_mode & 0o7777}
                for p in installed.rglob("*") if p.is_file()}
    actual = {str(p.relative_to(extracted)): {"sha256": module.sha(p), "mode": p.stat().st_mode & 0o7777}
              for p in extracted.rglob("*") if p.is_file()}
    # Non-root pkgutil extraction deliberately clears setuid bits. Verify the
    # installed modes/ownership in the package BOM, and extracted bytes plus
    # ordinary permission bits separately; do not chmod or install to test it.
    bom = subprocess.run(["/usr/bin/lsbom", "-f", str(expanded / "Bom")], capture_output=True, text=True, check=True).stdout
    installed_entries = {}
    prefix = "." + ROOT + "/"
    for line in bom.splitlines():
        fields = line.split("\t")
        if len(fields) != 5: raise RuntimeError("Malformed package BOM")
        name, mode, owner, size, _ = fields
        if Path(name).name.startswith("._"): continue  # AppleDouble metadata
        if not name.startswith(prefix): raise RuntimeError("Unexpected package file")
        key = name[len(prefix):]
        if key in installed_entries: raise RuntimeError("Duplicate package entry")
        installed_entries[key] = {"mode": int(mode, 8), "owner": owner, "size": int(size)}
    if set(actual) != set(expected) or set(installed_entries) != set(expected):
        raise RuntimeError("Package file set differs")
    for name, resource in expected.items():
        if actual[name]["sha256"] != resource["sha256"] or actual[name]["mode"] & 0o777 != resource["mode"] & 0o777:
            raise RuntimeError("Expanded bytes or permissions differ")
        if installed_entries[name] != {"mode": 0o100000 | resource["mode"], "owner": "0/0", "size": (installed / name).stat().st_size}:
            raise RuntimeError("Installed ownership or setuid mode differs")
    report = {"version": version, "role": role, "package": str(package), "packageSHA256": module.sha(package),
              "manifestSHA256": module.sha(manifest_path), "compiledSources": snapshot["files"], "files": expected,
              "installedFileMetadata": installed_entries, "coreProfile": core_profile, "coreVersion": profile["version"],
              "fixedCoreResourcesVerified": True, "originalOfficialMihomoUnchanged": True, "systemChangesExecuted": False, "installed": False,
              "readyForLiveAcceptance": False, "requiresIndependentReview": True, "userSubmissionLimitStillApplies": True}
    metadata = candidate / "candidate.json"; metadata.write_text(json.dumps(report, indent=2) + "\n")
    print(str(metadata))

if __name__ == "__main__": main()
