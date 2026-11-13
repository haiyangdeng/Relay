#!/usr/bin/env python3
"""Build one offline Installer product from a sealed App and the pinned helper.

Never installs packages, changes system state or opens/stops an application.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import uuid
import xml.etree.ElementTree as ET


APP = Path(__file__).resolve().parents[2]
APP_ID = "local.relay.network.app"
UNINSTALL_TEMPLATE = "native/installer/package/Uninstall-Relay.command"
NATIVE_RESOURCE = "Contents/Resources/relay/RelayNative"
UNINSTALL_SERVICE = "local.relay.network.uninstall"
HELPER_SCRIPTS = {
    "preinstall": "proxy-preinstall",
    "postinstall": "proxy-postinstall",
    "uninstall": "uninstall",
    "installation.template.json": "installation.template.json",
    "RelaySystemProxyHelper": "RelaySystemProxyHelper",
    "RelaySystemProxyClient": "RelaySystemProxyClient",
    "local.relay.network.system-proxy.plist": "local.relay.network.system-proxy.plist",
}


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def run(*arguments):
    return subprocess.check_output([str(item) for item in arguments], text=True).strip()


def inventory(directory):
    result = {}
    for path in directory.rglob("*"):
        name = str(path.relative_to(directory))
        if path.is_symlink():
            result[name] = {"link": os.readlink(path)}
        elif path.is_file():
            result[name] = {"sha256": digest(path), "mode": path.stat().st_mode & 0o7777}
        elif path.is_dir():
            result[name] = {"directory": True, "mode": path.stat().st_mode & 0o7777}
        else:
            raise RuntimeError("Unexpected App entry: " + name)
    return result


def script_inventory(directory):
    result = inventory(directory)
    for name, entry in list(result.items()):
        # pkgutil --expand can expose AppleDouble metadata as ._ files. Only
        # admit those accompanying a checked regular script or data file.
        if name.startswith("._") and "sha256" in entry and "sha256" in result.get(name[2:], {}):
            with (directory / name).open("rb") as stream:
                if stream.read(4) == b"\x00\x05\x16\x07":
                    del result[name]
    return result


def stage_uninstaller(app, output, native_sha):
    inspector = output / "Relay-Uninstall-Inspector"
    source = app / NATIVE_RESOURCE
    if source.is_symlink() or not source.is_file() or not os.access(source, os.X_OK):
        raise RuntimeError("Expected an executable RelayNative resource in the sealed App")
    shutil.copyfile(source, inspector)
    inspector.chmod(0o755)
    if digest(inspector) != native_sha:
        raise RuntimeError("Uninstall inspector does not match the sealed App")
    if sorted(run("/usr/bin/lipo", "-archs", inspector).split()) != ["arm64", "x86_64"]:
        raise RuntimeError("Uninstall inspector must support Apple Silicon and Intel")
    run("/usr/bin/codesign", "--verify", "--strict", "--all-architectures", inspector)
    template = (APP / UNINSTALL_TEMPLATE).read_bytes()
    token = b"@INSPECTOR_SHA256@"
    if template.count(token) != 1:
        raise RuntimeError("Expected one uninstall inspector pin in the command template")
    command = output / "Uninstall-Relay.command"
    command.write_bytes(template.replace(token, native_sha.encode("ascii")))
    command.chmod(0o755)
    run("/bin/sh", "-n", command)
    return {"uninstallCommandSHA256": digest(command), "uninstallInspectorSHA256": native_sha}


def verify_uninstall_build(directory):
    receipt = json.loads((directory / "build-receipt.json").read_text())
    if receipt.get("passed") is not True or sorted(receipt.get("architectures", [])) != ["arm64", "x86_64"]:
        raise RuntimeError("Unverified automatic uninstall supervisor build")
    for name, key in (("RelayUninstallSupervisor", "supervisorSHA256"),
                      (UNINSTALL_SERVICE + ".plist", "daemonSHA256")):
        path = directory / name
        if path.is_symlink() or not path.is_file() or digest(path) != receipt.get(key):
            raise RuntimeError("Uninstall supervisor build differs: " + name)
    supervisor = directory / "RelayUninstallSupervisor"
    if sorted(run("/usr/bin/lipo", "-archs", supervisor).split()) != ["arm64", "x86_64"]:
        raise RuntimeError("Uninstall supervisor must support Apple Silicon and Intel")
    run("/usr/bin/codesign", "--verify", "--strict", "--all-architectures", supervisor)
    daemon = plistlib.loads((directory / (UNINSTALL_SERVICE + ".plist")).read_bytes())
    if (daemon.get("Label") != UNINSTALL_SERVICE
            or daemon.get("ProgramArguments", [None])[0] != "/Library/Application Support/Relay/Uninstall/RelayUninstallSupervisor"
            or daemon.get("RunAtLoad") is not True
            or daemon.get("UserName", "root") != "root"):
        raise RuntimeError("Unexpected uninstall supervisor launch daemon")
    if not receipt.get("sourceSHA256"):
        raise RuntimeError("Uninstall supervisor build has no source provenance")
    for name, sha in receipt["sourceSHA256"].items():
        if digest(APP / name) != sha:
            raise RuntimeError("Uninstall supervisor source changed: " + name)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--helper-build", type=Path, required=True)
    parser.add_argument("--uninstall-build", type=Path,
                        help="Verified supervisor build; omitted builds it into a fresh private .relay-build directory")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", default=json.loads((APP / "package.json").read_text())["version"])
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.version):
        raise RuntimeError("Installer requires a stable semantic version")
    package_version = args.version
    if os.getuid() == 0 or os.geteuid() == 0:
        raise RuntimeError("Offline packaging refuses administrator execution")
    for path in [args.app, args.helper_build, args.output, *([args.uninstall_build] if args.uninstall_build else [])]:
        if not path.is_absolute():
            raise RuntimeError("All inputs and output must be explicit absolute paths")
    if args.output.exists() or args.output.is_symlink():
        raise RuntimeError("Existing output will not be overwritten")
    if args.app.name != "Relay.app" or args.app.is_symlink():
        raise RuntimeError("A sealed Relay.app directory is required")
    info = plistlib.loads((args.app / "Contents/Info.plist").read_bytes())
    if info.get("CFBundleShortVersionString") != package_version:
        raise RuntimeError("App and Installer versions differ")
    if info.get("CFBundleIdentifier") != "local.relay.network.preview":
        raise RuntimeError("Unexpected App identity")
    architecture = run("/usr/bin/lipo", "-archs", args.app / "Contents/MacOS/Relay")
    if architecture not in ["arm64", "x86_64"]:
        raise RuntimeError("Select one sealed native App architecture")
    run("/usr/bin/codesign", "--verify", "--deep", "--strict", args.app)
    helper_receipt = json.loads((args.helper_build / "build-receipt.json").read_text())
    helper_package = args.helper_build / "Relay-System-Proxy-Helper-v1.pkg"
    if (helper_receipt.get("passed") is not True or helper_receipt.get("freshInstallOnly") is not True
            or digest(helper_package) != helper_receipt["packageSHA256"]):
        raise RuntimeError("Unverified helper package or package permits reuse")
    for name, sha in helper_receipt["sourceSHA256"].items():
        if digest(APP / name) != sha:
            raise RuntimeError("Helper package source changed: " + name)
    own_sources = ["scripts/relay/build-integrated-installer.py", "native/installer/package/app-preinstall",
                   "native/installer/package/app-postinstall", "native/uninstall/README.md", UNINSTALL_TEMPLATE]
    source_hashes = {name: digest(APP / name) for name in own_sources}
    app_before = inventory(args.app)
    args.output.mkdir(parents=True)
    if args.uninstall_build is None:
        args.uninstall_build = APP / ".relay-build" / ("uninstall-supervisor-" + uuid.uuid4().hex)
        run("/bin/zsh", APP / "scripts/relay/build-uninstall-supervisor.zsh", "--output-dir", args.uninstall_build)
    supervisor_receipt = verify_uninstall_build(args.uninstall_build)
    native_sha = app_before.get(NATIVE_RESOURCE, {}).get("sha256")
    uninstall_receipt = stage_uninstaller(args.app, args.output, native_sha)
    payload = args.output / "payload"
    destination = payload / "Applications/Relay.app"
    destination.parent.mkdir(parents=True)
    run("/usr/bin/ditto", args.app, destination)
    if inventory(destination) != app_before:
        raise RuntimeError("App staging differs from the sealed input")
    component_info = args.output / "app-components.plist"
    run("/usr/bin/pkgbuild", "--analyze", "--root", payload, component_info)
    components = plistlib.loads(component_info.read_bytes())
    if not components or not any(item.get("RootRelativeBundlePath") == "Applications/Relay.app" for item in components):
        raise RuntimeError("App component destination is not fixed")
    def fix_bundle(item):
        item["BundleIsRelocatable"] = False
        item["BundleIsVersionChecked"] = False
        item["BundleOverwriteAction"] = "upgrade"
        for child in item.get("ChildBundles", []):
            fix_bundle(child)
    for item in components:
        fix_bundle(item)
    component_info.write_bytes(plistlib.dumps(components, sort_keys=True))
    scripts = args.output / "app-scripts"
    scripts.mkdir()
    # One component owns the App and all helper scripts. Installer runs this
    # preflight before writing the App and cannot reorder an independent helper
    # component ahead of it.
    for step in ("preinstall", "postinstall"):
        template = (APP / f"native/installer/package/app-{step}").read_text()
        if step == "postinstall":
            for token, value in {
                "@SUPERVISOR_SHA256@": supervisor_receipt["supervisorSHA256"],
                "@NATIVE_SHA256@": native_sha,
                "@UNINSTALL_DAEMON_SHA256@": supervisor_receipt["daemonSHA256"],
            }.items():
                if template.count(token) != 3:
                    raise RuntimeError("Expected source, publication and rollback pin: " + token)
                template = template.replace(token, value)
        (scripts / step).write_text(template)
        (scripts / step).chmod(0o755)
        run("/bin/sh", "-n", scripts / step)
    helper_expanded = args.output / "helper-expanded"
    run("/usr/sbin/pkgutil", "--expand", helper_package, helper_expanded)
    helper_scripts = helper_expanded / "Scripts"
    if set(script_inventory(helper_scripts)) != set(HELPER_SCRIPTS):
        raise RuntimeError("Unexpected helper scripts")
    for name, filename in HELPER_SCRIPTS.items():
        path = helper_scripts / name
        if path.is_symlink() or not path.is_file() or digest(path) != digest(args.helper_build / "Scripts" / name):
            raise RuntimeError("Unverified helper script: " + name)
        # Copy the verified data fork and ordinary permissions, not metadata
        # sidecars from the standalone package's scripts archive.
        shutil.copyfile(path, scripts / filename)
        (scripts / filename).chmod(path.stat().st_mode & 0o777)
    for name, source, mode in (
        ("RelayUninstallSupervisor", args.uninstall_build / "RelayUninstallSupervisor", 0o755),
        (UNINSTALL_SERVICE + ".plist", args.uninstall_build / (UNINSTALL_SERVICE + ".plist"), 0o644),
        ("RelayNative", args.app / NATIVE_RESOURCE, 0o755),
    ):
        shutil.copyfile(source, scripts / name)
        (scripts / name).chmod(mode)
    app_package = args.output / "Relay-App.pkg"
    run("/usr/bin/pkgbuild", "--root", payload, "--component-plist", component_info,
        "--scripts", scripts, "--identifier", APP_ID, "--version", package_version,
        "--ownership", "recommended", "--install-location", "/", app_package)
    distribution = ET.Element("installer-gui-script", {"minSpecVersion": "2"})
    ET.SubElement(distribution, "title").text = "Relay — App 与系统代理组件"
    ET.SubElement(distribution, "options", {"customize": "never", "hostArchitectures": architecture, "rootVolumeOnly": "true"})
    ET.SubElement(distribution, "domains", {"enable_anywhere": "false", "enable_currentUserHome": "false", "enable_localSystem": "true"})
    volume_check = ET.SubElement(distribution, "volume-check", {"script": "true"})
    versions = ET.SubElement(volume_check, "allowed-os-versions")
    ET.SubElement(versions, "os-version", {"min": "13.0"})
    choices = ET.SubElement(distribution, "choices-outline")
    ET.SubElement(choices, "line", {"choice": "app"})
    choice = ET.SubElement(distribution, "choice", {"id": "app", "visible": "false", "selected": "true"})
    ET.SubElement(choice, "pkg-ref", {"id": APP_ID})
    ET.SubElement(distribution, "pkg-ref", {"id": APP_ID, "version": package_version,
                                           "auth": "Root", "onConclusion": "None"}).text = app_package.name
    distribution_path = args.output / "Distribution.xml"
    ET.ElementTree(distribution).write(distribution_path, encoding="utf-8", xml_declaration=True)
    label = "Apple-Silicon" if architecture == "arm64" else "Intel"
    product = args.output / f"Relay-{package_version}-{label}-Installer.pkg"
    run("/usr/bin/productbuild", "--distribution", distribution_path, "--package-path", args.output, product)
    expanded = args.output / "expanded"
    run("/usr/sbin/pkgutil", "--expand-full", product, expanded)
    app_expanded = expanded / "Relay-App.pkg"
    if inventory(app_expanded / "Payload/Applications/Relay.app") != app_before:
        raise RuntimeError("Expanded App payload differs from the sealed input")
    if script_inventory(app_expanded / "Scripts") != script_inventory(scripts):
        raise RuntimeError("Expanded installer scripts differ")
    package_info = ET.parse(app_expanded / "PackageInfo").getroot()
    if (package_info.attrib.get("install-location") != "/" or package_info.attrib.get("relocatable") != "false"
            or package_info.attrib.get("auth") != "root" or package_info.findall("./relocate/*")
            or package_info.findall(".//locator")):
        raise RuntimeError("App component permits unexpected relocation")
    if {stage.tag: stage.attrib.get("file") for stage in package_info.findall("./scripts/*")} != {
        "preinstall": "./preinstall", "postinstall": "./postinstall"
    }:
        raise RuntimeError("Installer entry points differ")
    expanded_distribution = ET.parse(expanded / "Distribution").getroot()
    minimum = expanded_distribution.find("./volume-check/allowed-os-versions/os-version")
    if minimum is None or minimum.attrib.get("min") != "13.0" or expanded_distribution.find("./allowed-os-versions") is not None:
        raise RuntimeError("Product does not enforce the declared macOS minimum")
    refs = expanded_distribution.findall("./pkg-ref")
    if ({item.attrib.get("id") for item in refs} != {APP_ID}
            or [item.text.strip() for item in refs if item.text and item.text.strip()] != ["#Relay-App.pkg"]):
        raise RuntimeError("Installer no longer has a single App and helper component")
    for name, sha in source_hashes.items():
        if digest(APP / name) != sha:
            raise RuntimeError("Installer source changed during build: " + name)
    if inventory(args.app) != app_before or digest(helper_package) != helper_receipt["packageSHA256"]:
        raise RuntimeError("Sealed inputs changed during build")
    if verify_uninstall_build(args.uninstall_build) != supervisor_receipt:
        raise RuntimeError("Uninstall supervisor build changed during packaging")
    receipt = {
        "passed": True, "version": package_version, "architecture": architecture, "product": str(product), "productSHA256": digest(product),
        "appComponentSHA256": digest(app_package), "helperPackageSHA256": digest(helper_package),
        "appASARSHA256": digest(args.app / "Contents/Resources/app.asar"),
        "appPayloadByteIdentical": True, "appSymlinksAndModesIdentical": True,
        "helperScriptsByteIdentical": True, "fixedAppDestination": "/Applications/Relay.app",
        "bundleRelocationDisabled": True, "existingAppRefused": True, "automaticAppLaunch": False,
        "freshInstallOnly": True, "singleComponent": True, "helperInstalledInPostinstall": True,
        "automaticTrashUninstall": True, "uninstallMonitorInstalledInPostinstall": True,
        "uninstallSupervisorSHA256": supervisor_receipt["supervisorSHA256"],
        "uninstallSupervisorBuild": str(args.uninstall_build),
        "uninstallDaemonSHA256": supervisor_receipt["daemonSHA256"],
        "fixedUninstallRoot": "/Library/Application Support/Relay/Uninstall",
        **uninstall_receipt,
        "sourceSHA256": {**helper_receipt["sourceSHA256"], **supervisor_receipt["sourceSHA256"], **source_hashes},
        "installed": False, "realNetworkChanged": False, "realAuthorizationRequested": False,
        "crossComponentAtomicRollbackPromised": False,
    }
    (args.output / "build-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
