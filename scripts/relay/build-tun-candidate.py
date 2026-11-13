#!/usr/bin/env python3
"""Build and inspect an network-executor development package. Never install or run it."""

import argparse
import datetime
import hashlib
import gzip
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import subprocess
import uuid
import xml.etree.ElementTree as ET


APP = Path(__file__).resolve().parents[2]
SERVICE = "local.relay.network.tun"
RECEIPT = SERVICE + ".network-executor-v1"
VERSION = "0.30.1"
CONTAINER = "/Library/Application Support/Relay"
ROOT = CONTAINER + "/Tun"
PATHS = {
    "helper": "/Library/PrivilegedHelperTools/" + SERVICE,
    "client": ROOT + "/RelayTunClient",
    "uninstaller": "/Library/PrivilegedHelperTools/" + SERVICE + ".uninstall",
    "manifest": ROOT + "/installation.json",
    "launchDaemon": "/Library/LaunchDaemons/" + SERVICE + ".plist",
}
CORE_PATHS = {
    "arm64": ROOT + "/Core/darwin-arm64/mihomo",
    "x86_64": ROOT + "/Core/darwin-x64/mihomo",
}
OWNED_DIRECTORIES = [
    CONTAINER,
    ROOT,
    ROOT + "/Core",
    ROOT + "/Core/darwin-arm64",
    ROOT + "/Core/darwin-x64",
]
INTENT = "/Library/PrivilegedHelperTools/" + SERVICE + ".uninstall-intent.json"
PARENT_TOKENS = {
    "/": "@VOLUME_ROOT_METADATA@",
    "/Library": "@LIBRARY_METADATA@",
    "/Library/Application Support": "@APPLICATION_SUPPORT_METADATA@",
    "/Library/PrivilegedHelperTools": "@PRIVILEGED_HELPERS_METADATA@",
    "/Library/LaunchDaemons": "@LAUNCH_DAEMONS_METADATA@",
}
CORE_PINS = {
    "arm64": ("f3e8ae41397c08cbf900ce1f7c8a168285d29954e9bca5d84d69a2b2561adfe9", 56810034),
    "x86_64": ("291f5923c3dd3b8df36eaeccdd59eaf873ee021693cde65eb696f8b86ac99652", 60945968),
}
SOURCE_COPY_EVIDENCE = []


def metadata_output(arguments):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--metadata-output", help="New absolute JSON evidence path; never replaces existing evidence")
    options = parser.parse_args(arguments)
    if options.metadata_output is None:
        return APP.parent / "evidence/tun-helper-transport-candidate.json", False
    path = Path(options.metadata_output)
    expected_parent = APP.parent / "evidence"
    if (not path.is_absolute() or path.suffix != ".json" or path.parent != expected_parent
            or path.parent.resolve(strict=True) != path.parent or path.exists() or path.is_symlink()):
        raise RuntimeError("Explicit metadata output must be a new physical JSON path in this project's evidence directory")
    return path, True


def run(args, cwd=None):
    return subprocess.run(
        args,
        check=True,
        capture_output=True,
        text=True,
        timeout=180,
        cwd=cwd,
        env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C", "LC_ALL": "C"},
    )


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for part in iter(lambda: stream.read(65536), b""):
            digest.update(part)
    return digest.hexdigest()


def source_info(path):
    info = path.lstat()
    if (
        path.resolve() != path
        or not stat.S_ISREG(info.st_mode)
        or info.st_nlink != 1
        or info.st_uid not in (0, os.getuid())
        or info.st_mode & 0o7022
        or not 0 < info.st_size <= 134217728
    ):
        raise RuntimeError("Untrusted or changed package source")
    return info


def attributes(path, *, source_ancestor=False):
    names = set(run(["/usr/bin/xattr", str(path)]).stdout.splitlines())
    # A source ancestor's existing access metadata is observed, hashed and
    # compared unchanged. It is never copied to the payload or removed from
    # the user's directory. Files and all staging objects remain narrower.
    allowed = {"com.apple.provenance"} | ({"com.apple.macl"} if source_ancestor else set())
    if not names.issubset(allowed):
        raise RuntimeError("Source or staging quarantine/unknown extended attributes require review")
    result = {}
    for name in sorted(names):
        raw = bytes.fromhex(run(["/usr/bin/xattr", "-px", name, str(path)]).stdout)
        result[name] = hashlib.sha256(raw).hexdigest()
    return result


def source_chain(path):
    if APP not in path.parents:
        raise RuntimeError("Source must remain inside the fixed application project")
    chain = [path]
    parent = path.parent
    while True:
        chain.append(parent)
        if parent == APP:
            break
        parent = parent.parent
    result = {}
    for item in chain:
        info = item.lstat()
        if item.resolve() != item or info.st_uid not in (0, os.getuid()) or (item != path and (not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o6022)):
            raise RuntimeError("Unsafe copy-source ancestry")
        result[str(item.relative_to(APP))] = {"dev": info.st_dev, "ino": info.st_ino, "uid": info.st_uid, "gid": info.st_gid, "mode": info.st_mode, "attributes": attributes(item, source_ancestor=item != path)}
    return result


def copy_source(source, destination, mode):
    source_before = source_chain(source)
    before = source_info(source)
    digest = sha(source)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    if destination.exists() or destination.is_symlink():
        raise RuntimeError("Offline payload destination already exists")
    shutil.copyfile(source, destination)
    destination.chmod(mode)
    after = source_info(source)
    source_after = source_chain(source)
    if (
        (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
        != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        or sha(destination) != digest
        or sha(source) != digest
        or source_before != source_after
    ):
        raise RuntimeError("Package source changed during copying")
    SOURCE_COPY_EVIDENCE.append({"source": str(source.relative_to(APP)), "sourceSHA256Before": digest, "sourceSHA256After": sha(source), "sourceAndAncestorAttributesUnchanged": True, "attributeSnapshotSHA256": hashlib.sha256(json.dumps(source_before, sort_keys=True).encode()).hexdigest(), "onlyAttributeNames": sorted({name for item in source_before.values() for name in item["attributes"]}), "binaryAttributeNames": sorted(source_before[str(source.relative_to(APP))]["attributes"]), "sourceAttributesNeverModifiedOrCopied": True})


def code_pin(path):
    info = source_info(path)
    run(["/usr/bin/codesign", "--verify", "--strict", "--all-architectures", str(path)])
    if set(run(["/usr/bin/lipo", "-archs", str(path)]).stdout.split()) != {"arm64", "x86_64"}:
        raise RuntimeError("Candidate must contain both macOS architectures")
    hashes = {}
    for arch in ["arm64", "x86_64"]:
        result = run(["/usr/bin/codesign", "--display", "--verbose=4", "--arch", arch, str(path)])
        output = result.stdout + result.stderr
        matches = re.findall(r"^CDHash=([a-f0-9]{40})$", output, re.M)
        if len(matches) != 1 or "runtime" not in output:
            raise RuntimeError("Missing exact hardened-runtime code identity")
        hashes[arch] = matches[0]
    return {"sha256": sha(path), "size": info.st_size, "cdhashes": hashes}


def parent_metadata():
    result = {}
    for raw in PARENT_TOKENS:
        path = Path(raw)
        info = path.lstat()
        if path.resolve() != path or not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o6022:
            raise RuntimeError("Existing shared parent is not root protected")
        result[raw] = {"uid": info.st_uid, "gid": info.st_gid, "mode": format(stat.S_IMODE(info.st_mode), "o")}
    return result


def attributes_only_build_provenance(root):
    for path in [root, *root.rglob("*")]:
        info = path.lstat()
        if path.resolve() != path or info.st_uid != os.getuid() or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            raise RuntimeError("Unsafe offline payload staging object")
        attributes(path)


def standard_cpio(source, paths, destination, listing):
    listing.write_text("\n".join(paths) + "\n")
    if destination.exists() or destination.is_symlink():
        raise RuntimeError("Offline normalized archive already exists; nothing was replaced")
    run(["/usr/bin/tar", "--format", "odc", "--uid", "0", "--gid", "0", "--no-xattrs", "--no-mac-metadata", "--no-acls", "--no-fflags", "--no-recursion", "-czf", str(destination), "-C", str(source), "-T", str(listing)])
    observed = run(["/usr/bin/tar", "-tzf", str(destination)]).stdout.splitlines()
    if observed != paths:
        raise RuntimeError("Standard CPIO archive inventory differs from the exact allowlist")
    entries = []
    with gzip.open(destination, "rb") as stream:
        while True:
            header = stream.read(76)
            if len(header) != 76 or header[:6] != b"070707":
                raise RuntimeError("Unexpected CPIO header")
            mode, uid, gid, links = [int(header[start:start + 6], 8) for start in [18, 24, 30, 36]]
            name_size, size = int(header[59:65], 8), int(header[65:76], 8)
            if not 1 <= name_size <= 1024 or not 0 <= size <= 134217728:
                raise RuntimeError("CPIO entry exceeds fixed build bounds")
            raw_name = stream.read(name_size)
            if len(raw_name) != name_size or not raw_name.endswith(b"\x00"):
                raise RuntimeError("CPIO name truncated")
            name = raw_name[:-1].decode("utf-8")
            if name == "TRAILER!!!":
                if size != 0:
                    raise RuntimeError("CPIO trailer contains data")
                break
            if name not in paths or uid != 0 or gid != 0:
                raise RuntimeError("CPIO entry escapes candidate inventory or root ownership")
            original = source / name.removeprefix("./")
            info = original.lstat()
            if mode != info.st_mode or not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)) or (stat.S_ISREG(mode) and links != 1):
                raise RuntimeError("CPIO entry mode or link count changed")
            digest = hashlib.sha256()
            remaining = size
            while remaining:
                part = stream.read(min(65536, remaining))
                if not part:
                    raise RuntimeError("CPIO file truncated")
                digest.update(part)
                remaining -= len(part)
            if stat.S_ISREG(mode) and (size != info.st_size or digest.hexdigest() != sha(original)):
                raise RuntimeError("CPIO file bytes changed")
            entries.append({"path": name, "mode": format(mode, "o"), "uid": uid, "gid": gid, "size": size})
    if [entry["path"] for entry in entries] != paths:
        raise RuntimeError("CPIO has a missing or repeated candidate entry")
    return entries


def package_without_build_metadata(raw, package, candidate, payload, scripts, shared):
    # The vendor package remains an audit input. Standard Apple BOM tools and
    # standard gzip/odc CPIO exclude only auto-created build provenance metadata.
    # No source/staging xattrs or machine security policy is changed.
    attributes_only_build_provenance(payload)
    attributes_only_build_provenance(scripts)
    expanded = candidate / "vendor-expanded"
    run(["/usr/sbin/pkgutil", "--expand", str(raw), str(expanded)])
    if {path.name for path in expanded.iterdir()} != {"Bom", "PackageInfo", "Payload", "Scripts"}:
        raise RuntimeError("Unexpected vendor package component")
    normalized = candidate / "normalized-package"
    normalized.mkdir(mode=0o700)
    expected_files = (set(PATHS.values()) | set(CORE_PATHS.values())) - {PATHS["uninstaller"]}
    shared_nodes = {"." if path == "/" else "." + path for path in shared}
    owned_nodes = {"." + path for path in OWNED_DIRECTORIES}
    file_nodes = {"." + path for path in expected_files}
    logical_nodes = shared_nodes | owned_nodes | file_nodes
    vendor_rows = run(["/usr/bin/lsbom", str(expanded / "Bom")]).stdout.splitlines()
    filtered = []
    removed_metadata = []
    observed_nodes = set()
    for row in vendor_rows:
        fields = row.split("\t")
        node = fields[0]
        if Path(node).name.startswith("._"):
            counterpart = str(Path(node).with_name(Path(node).name[2:]))
            if not counterpart.startswith("./"):
                counterpart = "./" + counterpart
            if counterpart not in logical_nodes or len(fields) != 5 or fields[3:] != ["0", "0"]:
                raise RuntimeError("Unknown virtual metadata entry requires review")
            removed_metadata.append(node)
            continue
        if node not in logical_nodes or node in observed_nodes:
            raise RuntimeError("Unknown or duplicate vendor BOM entry")
        observed_nodes.add(node)
        absolute = "/" if node == "." else node[1:]
        if absolute in shared:
            info = shared[absolute]
            fields = [node, format(stat.S_IFDIR | int(info["mode"], 8), "o"), str(info["uid"]) + "/" + str(info["gid"])]
        filtered.append("\t".join(fields))
    if observed_nodes != logical_nodes:
        raise RuntimeError("Vendor BOM lacks expected navigation or candidate files")
    input_bom = candidate / "logical-payload-bom.txt"
    input_bom.write_text("\n".join(filtered) + "\n")
    run(["/usr/bin/mkbom", "-i", str(input_bom), str(normalized / "Bom")])
    # Shared parents are existing navigation records only. Their archive entries
    # are omitted, so no source folder metadata is applied to existing parents.
    payload_nodes = sorted(owned_nodes | file_nodes)
    payload_entries = standard_cpio(payload, payload_nodes, normalized / "Payload", candidate / "payload-members.txt")
    script_entries = standard_cpio(scripts, ["./RecoveryIntent.json", "./RecoveryUninstaller", "./postinstall", "./preinstall"], normalized / "Scripts", candidate / "script-members.txt")
    info = ET.parse(expanded / "PackageInfo")
    info.getroot().find("payload").set("numberOfFiles", str(len(payload_nodes)))
    info.write(normalized / "PackageInfo", encoding="UTF-8", xml_declaration=True)
    # pkgutil --flatten implicitly archives its Scripts argument again. The
    # standard flat-package XAR container receives our already audited CPIO as
    # opaque bytes so Scripts never becomes a nested Scripts/Scripts resource.
    run(["/usr/bin/xar", "-c", "--compression=none", "--distribution", "-f", str(package), "Bom", "PackageInfo", "Payload", "Scripts"], cwd=str(normalized))
    return {"removedVirtualBuildMetadata": removed_metadata, "payloadArchivePaths": payload_nodes, "bomNavigationPaths": sorted(shared_nodes), "payloadCPIO": payload_entries, "scriptsCPIO": script_entries}


def main():
    if os.getuid() <= 0 or os.geteuid() != os.getuid():
        raise RuntimeError("Offline build only, as the current ordinary user")
    evidence, exclusive_metadata = metadata_output(os.sys.argv[1:])
    sources = APP / "native/tun"
    compiled = APP / ".relay-build/tun-helper"
    source_manifest = compiled / "shipping-sources.json"
    source_snapshot = json.loads(source_manifest.read_text())
    if source_snapshot.get("version") != 1 or not isinstance(source_snapshot.get("files"), dict):
        raise RuntimeError("Missing exact compiled source manifest")
    required_sources = {"native/tun/RelayTunHelperMain.swift", "native/tun/RelayTunExecutorService.swift", "native/tun/RelayTunPrivilegedExecutor.swift", "native/tun/RelayTunAppSession.swift", "native/tun/RelayTunClientMain.swift", "scripts/relay/build-tun-helper.zsh"}
    if not required_sources.issubset(source_snapshot["files"]):
        raise RuntimeError("Compiled source manifest omits a production entry or executor")
    for name, digest in source_snapshot["files"].items():
        path = APP / name
        if not isinstance(name, str) or path.resolve().is_relative_to(APP) is False or sha(path) != digest:
            raise RuntimeError("Rebuild helper/client/uninstaller after shipping source changes: " + str(name))
    linked_sources = source_snapshot["files"]
    names = {"helper": "RelayTunHelper", "client": "RelayTunClient", "uninstaller": "RelayTunUninstall"}
    for name in names.values():
        if (compiled / name).stat().st_mtime_ns < max((APP / item).stat().st_mtime_ns for item in linked_sources):
            raise RuntimeError("Rebuild helper/client/uninstaller before packaging changed sources")
    if "RelayTunHelperListener(trust: trust, service: service)" not in (sources / "RelayTunHelperMain.swift").read_text() or "RelayTunExecutorService()" not in (sources / "RelayTunHelperMain.swift").read_text():
        raise RuntimeError("Network executor must be constructed by HelperMain before packaging")
    now = datetime.datetime.now(datetime.timezone.utc)
    shared = parent_metadata()
    candidate = APP / ".relay-build" / ("tun-network-candidate-" + now.strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:8])
    candidate.mkdir(mode=0o700)
    payload, scripts = candidate / "payload", candidate / "scripts"
    payload.mkdir(mode=0o755)
    scripts.mkdir(mode=0o755)
    pins = {}
    for key, name in names.items():
        destination = scripts / "RecoveryUninstaller" if key == "uninstaller" else payload / PATHS[key].lstrip("/")
        copy_source(compiled / name, destination, 0o755)
        pins[key] = code_pin(destination)
    core_metadata = {}
    for arch, source_arch in [("arm64", "arm64"), ("x86_64", "x64")]:
        destination = payload / CORE_PATHS[arch].lstrip("/")
        copy_source(APP / "extra/relay/core" / ("darwin-" + source_arch) / "mihomo", destination, 0o755)
        if (sha(destination), destination.stat().st_size) != CORE_PINS[arch]:
            raise RuntimeError("Pinned inert core bytes do not match")
        core_metadata[arch] = {"sha256": CORE_PINS[arch][0], "size": CORE_PINS[arch][1]}
    daemon = {
        "Label": SERVICE,
        "ProgramArguments": [PATHS["helper"], "--serve"],
        "MachServices": {SERVICE: True},
        "UserName": "root",
        "GroupName": "wheel",
        "ProcessType": "Background",
        "RunAtLoad": False,
        "KeepAlive": False,
    }
    daemon_path = payload / PATHS["launchDaemon"].lstrip("/")
    daemon_path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    daemon_path.write_bytes(plistlib.dumps(daemon, fmt=plistlib.FMT_XML, sort_keys=True))
    daemon_path.chmod(0o644)
    manifest = {
        "version": 2,
        "role": "network-executor-v1",
        "service": SERVICE,
        "clientUID": os.getuid(),
        **pins,
        "launchDaemonSHA256": sha(daemon_path),
        "cores": core_metadata,
    }
    manifest_path = payload / PATHS["manifest"].lstrip("/")
    manifest_path.write_text(json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n")
    manifest_path.chmod(0o644)
    for installed in OWNED_DIRECTORIES:
        directory = payload / installed.lstrip("/")
        directory.mkdir(parents=True, exist_ok=True, mode=0o755)
        if directory.resolve() != directory or directory.lstat().st_uid != os.getuid() or not directory.is_dir():
            raise RuntimeError("Owned staging directory identity is not confirmed")
        directory.chmod(0o755)
    intent_pins = {PATHS[key]: pin["sha256"] for key, pin in pins.items()}
    intent_pins.update({PATHS["manifest"]: sha(manifest_path), PATHS["launchDaemon"]: sha(daemon_path)})
    intent_pins.update({CORE_PATHS[arch]: value["sha256"] for arch, value in core_metadata.items()})
    recovery_intent = {"version": 1, "role": "network-executor-v1-uninstall", "service": SERVICE, "receiptID": RECEIPT, "clientUID": os.getuid(), "pins": intent_pins}
    recovery_intent_path = scripts / "RecoveryIntent.json"
    recovery_intent_path.write_text(json.dumps(recovery_intent, sort_keys=True, separators=(",", ":")))
    recovery_intent_path.chmod(0o644)
    for name in ["preinstall", "postinstall"]:
        copy_source(sources / "package" / name, scripts / name, 0o755)
        if name == "preinstall":
            script = (scripts / name).read_text()
            for path, token in PARENT_TOKENS.items():
                info = shared[path]
                if script.count(token) != 1:
                    raise RuntimeError("Shared-parent binding template changed")
                script = script.replace(token, str(info["uid"]) + ":" + str(info["gid"]) + ":" + format(stat.S_IFDIR | int(info["mode"], 8), "o") + ":Directory")
            for token, value in {"@RECOVERY_UNINSTALLER_SHA256@": pins["uninstaller"]["sha256"], "@RECOVERY_INTENT_SHA256@": sha(recovery_intent_path), "@ORIGINAL_MANIFEST_SHA256@": sha(manifest_path)}.items():
                if script.count(token) != 1:
                    raise RuntimeError("Recovery predeployment binding template changed")
                script = script.replace(token, value)
            (scripts / name).write_text(script)
        run(["/bin/sh", "-n", str(scripts / name)])
    # Confirm normal users cannot execute package preflight past its root gate.
    denied = subprocess.run(["/bin/sh", str(scripts / "preinstall"), "fixture", "/", "/"], capture_output=True, timeout=5)
    if denied.returncode != 1:
        raise RuntimeError("Ordinary-user installer gate did not reject")
    package = candidate / "RelayTun-NetworkExecutor-v1.pkg"
    raw = candidate / "Vendor-With-Build-Metadata.pkg"
    run(["/usr/bin/pkgbuild", "--identifier", RECEIPT, "--version", VERSION, "--install-location", "/", "--ownership", "recommended", "--root", str(payload), "--scripts", str(scripts), str(raw)])
    normalized_metadata = package_without_build_metadata(raw, package, candidate, payload, scripts, shared)
    expanded = candidate / "expanded"
    run(["/usr/sbin/pkgutil", "--expand-full", str(package), str(expanded)])
    package_info = ET.parse(expanded / "PackageInfo").getroot().attrib
    if package_info.get("identifier") != RECEIPT or package_info.get("version") != VERSION or package_info.get("install-location") != "/":
        raise RuntimeError("Package identity/location changed")
    installed_files = set(PATHS.values()) | set(CORE_PATHS.values())
    expected_files = installed_files - {PATHS["uninstaller"]}
    bom = run(["/usr/bin/lsbom", "-f", "-p", "fmug", str(expanded / "Bom")]).stdout
    observed_files, ownership = set(), []
    for line in bom.splitlines():
        relative, mode, uid, gid = line.split("\t")
        absolute = "/" + relative.removeprefix("./").lstrip("/")
        expected_mode = 0o100644 if absolute in (PATHS["manifest"], PATHS["launchDaemon"]) else 0o100755
        if absolute not in expected_files or int(mode, 8) != expected_mode or uid != "0":
            raise RuntimeError("Package BOM has unexpected file, mode or owner")
        observed_files.add(absolute)
        ownership.append({"path": absolute, "mode": mode, "uid": int(uid), "gid": int(gid)})
    if observed_files != expected_files:
        raise RuntimeError("Package payload does not exactly match the six payload files")
    directory_rows = run(["/usr/bin/lsbom", "-d", "-p", "fmug", str(expanded / "Bom")]).stdout
    observed_directories = {}
    for line in directory_rows.splitlines():
        relative, mode, uid, gid = line.split("\t")
        absolute = "/" if relative == "." else "/" + relative.removeprefix("./").lstrip("/")
        expected = shared.get(absolute, {"uid": 0, "gid": 0, "mode": "755"})
        if absolute not in set(OWNED_DIRECTORIES) | set(shared) or int(mode, 8) != stat.S_IFDIR | int(expected["mode"], 8) or int(uid) != expected["uid"] or int(gid) != expected["gid"]:
            raise RuntimeError("Package directory BOM changed owned or shared metadata")
        observed_directories[absolute] = {"uid": int(uid), "gid": int(gid), "mode": format(int(mode, 8) & 0o7777, "o")}
    if set(observed_directories) != set(OWNED_DIRECTORIES) | set(shared):
        raise RuntimeError("Package directory navigation inventory differs")
    for installed in expected_files:
        extracted = expanded / "Payload" / installed.lstrip("/")
        if not extracted.is_file() or extracted.is_symlink() or sha(extracted) != sha(payload / installed.lstrip("/")):
            raise RuntimeError("Expanded package payload bytes differ")
    for key in names:
        resource = expanded / "Scripts/RecoveryUninstaller" if key == "uninstaller" else expanded / "Payload" / PATHS[key].lstrip("/")
        if code_pin(resource) != pins[key]:
            raise RuntimeError("Expanded code identity changed")
    if set(path.name for path in (expanded / "Scripts").iterdir()) != {"preinstall", "postinstall", "RecoveryUninstaller", "RecoveryIntent.json"}:
        raise RuntimeError("Unexpected installer script")
    for name in ["preinstall", "postinstall", "RecoveryUninstaller", "RecoveryIntent.json"]:
        if sha(expanded / "Scripts" / name) != sha(scripts / name):
            raise RuntimeError("Installer script bytes changed")
    installed_paths = sorted(installed_files)
    metadata = {
        "date": now.date().isoformat(),
        "role": "network-executor-v1",
        "clientUID": os.getuid(),
        "packagePath": str(package),
        "packageSHA256": sha(package),
        "receiptID": RECEIPT,
        "packageVersion": VERSION,
        "service": SERVICE,
        "manifestPath": PATHS["manifest"],
        "manifestSHA256": sha(manifest_path),
        "launchDaemonPath": PATHS["launchDaemon"],
        "launchDaemonSHA256": sha(daemon_path),
        "binaryPins": {key: {"path": PATHS[key], **pin} for key, pin in pins.items()},
        "corePins": {arch: {"path": CORE_PATHS[arch], **pin} for arch, pin in core_metadata.items()},
        "installedPaths": installed_paths,
        "payloadFiles": sorted(expected_files),
        "preinstallDeployedPaths": [PATHS["uninstaller"], INTENT],
        "recoveryResources": {"uninstallerSHA256": pins["uninstaller"]["sha256"], "intentSHA256": sha(recovery_intent_path), "originalManifestSHA256": sha(manifest_path)},
        "temporaryPrefixes": ["/Library/PrivilegedHelperTools/.local.relay.network.tun.network-executor-v1-publish-"],
        "ownedDirectories": OWNED_DIRECTORIES,
        "transientUninstallIntentPath": INTENT,
        "sharedParentMetadata": shared,
        "metadataPackaging": normalized_metadata,
        "uninstallArguments": ["--remove", sha(manifest_path)],
        "preinstallRequiresOriginalAbsence": ["/Library/PrivilegedHelperTools/" + SERVICE + ".operation-lock", "/Library/PrivilegedHelperTools/" + SERVICE + ".uninstall-active", CONTAINER, PATHS["helper"], PATHS["uninstaller"], PATHS["launchDaemon"], INTENT, "job:system/" + SERVICE, "receipt:" + RECEIPT],
        "postinstallRegistersOnlyFixedMachJob": True,
        "runAtLoad": False,
        "keepAlive": False,
        "executorAvailable": True,
        "runtimeRecoveryRequiredBeforeUninstall": True,
        "dynamicRuntimePaths": [ROOT + "/NetworkJournal", ROOT + "/DeviceJournal", "/Library/PrivilegedHelperTools/" + SERVICE + ".operation-lock", "/Library/PrivilegedHelperTools/" + SERVICE + ".uninstall-active"],
        "ready": False,
        "protectionVerified": False,
        "installedOrMachAuthenticated": False,
        "actualSystemConfigurationChanged": False,
        "offlineChecks": {"sevenExactInstalledFiles": True, "sixExactPayloadFiles": True, "expandedPayloadHashesMatch": True, "rootOwnershipInBOMAndCPIO": True, "scriptsAndRecoveryResourcesExact": True, "scriptsSyntaxChecked": True, "ordinaryUserPreinstallRejected": True, "bothArchitecturesSignedWithHardenedRuntime": True, "sharedParentsExcludedFromCPIO": True, "sharedParentBOMMatchesObservedMetadata": True, "onlyVirtualProvenanceMetadataExcluded": True, "sourceAndSystemAttributesUnchanged": True, "ownedStagingDirectoriesExplicit755": True, "uninstallerExcludedFromPayloadOverwrite": True},
        "payloadOwnership": ownership,
        "candidateDirectory": str(candidate),
        "linkedSourceSHA256": dict(linked_sources),
        "shippingSourceManifestSHA256": sha(source_manifest),
        "packagerSHA256": sha(Path(__file__).resolve()),
        "knownRetainedAuditNamespace": "/Library/Application Support/RelayTunRecovery",
        "manifestVersion": 2,
        "sourceCopyPreservation": SOURCE_COPY_EVIDENCE,
        "limitations": ["Ad-hoc development signatures, not a notarized production installer", "Bound to the current machine's ordinary UID", "No live root/Mach or Intel hardware acceptance", "Live executor is compiled and linked but no helper/TUN/network operation has been installed or run by packaging", "Runtime journals preserve recovery evidence and must be retired explicitly before uninstall; unknown content blocks cleanup", "Multi-file removal is resumable for ordinary failures but not an atomic power-loss promise; unknown changes block cleanup"],
    }
    if exclusive_metadata:
        with evidence.open("x", encoding="utf-8") as stream:
            stream.write(json.dumps(metadata, indent=2, ensure_ascii=False) + "\n")
        evidence.chmod(0o600)
    else:
        evidence.write_text(json.dumps(metadata, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"metadata": str(evidence), "packagePath": str(package), "packageSHA256": metadata["packageSHA256"], "installedOrMachAuthenticated": False}))


if __name__ == "__main__":
    main()
