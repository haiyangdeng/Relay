#!/usr/bin/env python3
"""Exercise Installer shell entry points against a disposable filesystem."""
import os
import hashlib
import importlib.util
import json
import plistlib
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest
from unittest import mock


APP = Path(__file__).resolve().parents[2]
INSTALLER = APP / "native/installer/package"


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="relay-pkg-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.environment = {**os.environ, "RELAY_TEST_UID": "0"}
        self.trace = self.root / "trace"
        self.environment["RELAY_TEST_TRACE"] = str(self.trace)
        self.preinstall = self.root / "preinstall"
        self.postinstall = self.root / "postinstall"
        self.home = self.root / "Users/test"
        self.home.mkdir(parents=True)
        self.environment["RELAY_TEST_HOME"] = str(self.home)
        self.environment["RELAY_TEST_ROOT"] = str(self.root)
        for directory in ("Applications", "Library/Application Support/Relay", "Library/LaunchDaemons"):
            (self.root / directory).mkdir(parents=True)
        self.monitor = self.root / "Library/Application Support/Relay/Uninstall"
        self.daemon = self.root / "Library/LaunchDaemons/local.relay.network.uninstall.plist"
        self.executable(self.root / "RelayUninstallSupervisor", '''#!/bin/sh
case "$1" in
--register)
    printf 'register %s %s %s %s\\n' "$2" "$3" "$4" "$5" >> "$RELAY_TEST_TRACE"
    [ -z "${RELAY_TEST_REGISTER_FAILURE:-}" ] || exit 17
    printf '{}\\n' > "$(dirname "$0")/installation.json"
    ;;
--verify-ready)
    echo verify-ready >> "$RELAY_TEST_TRACE"
    if [ -n "${RELAY_TEST_REMOVAL_DURING_READY:-}" ]; then
        printf '{}\\n' > "$(dirname "$0")/intent.json"
        /bin/chmod 644 "$(dirname "$0")/intent.json"
        exit 18
    fi
    [ -z "${RELAY_TEST_READY_FAILURE:-}" ] || exit 18
    printf '{}\\n' > "$(dirname "$0")/ready.json"
    ;;
*) exit 99;;
esac
''')
        self.executable(self.root / "RelayNative", "#!/bin/sh\nexit 0\n")
        (self.root / "local.relay.network.uninstall.plist").write_text("test daemon\n")
        (self.root / "local.relay.network.uninstall.plist").chmod(0o644)
        tools = {
            "/usr/bin/id": '''case "$1:$2" in
-nu:*) echo test;;
-u:test) echo "${RELAY_TEST_CONSOLE_UID:-501}";;
-u:) echo "$RELAY_TEST_UID";;
*) exit 9;; esac''',
            "/usr/bin/stat": '''case "$2" in
%u) case "$3" in /dev/console) echo "${RELAY_TEST_CONSOLE_UID:-501}";; "$RELAY_TEST_HOME") echo 501;; *) echo 0;; esac;;
%g) echo 0;;
%Lp) /usr/bin/stat -f '%Lp' "$3";;
%u:%Lp:%l) printf '0:%s\\n' "$(/usr/bin/stat -f '%Lp:%l' "$3")";;
%u:%l) printf '0:%s\\n' "$(/usr/bin/stat -f '%l' "$3")";;
%d:%i) /usr/bin/stat -f '%d:%i' "$3";;
*) exit 9;; esac''',
            "/usr/sbin/pkgutil": 'printf "%s\\n" "${RELAY_TEST_RECEIPTS:-}"',
            "/bin/launchctl": '''
case "$1" in
bootstrap)
    echo bootstrap >> "$RELAY_TEST_TRACE"
    [ -z "${RELAY_TEST_BOOTSTRAP_FAILURE:-}" ] || exit 20
    touch "$RELAY_TEST_ROOT/job-active"
    exit 0;;
bootout)
    echo bootout >> "$RELAY_TEST_TRACE"
    if [ -n "${RELAY_TEST_DRAIN:-}" ]; then
        echo 0 > "$RELAY_TEST_ROOT/draining"
    else
        rm -f "$RELAY_TEST_ROOT/job-active"
    fi
    exit 0;;
esac
if [ "$2" = system/local.relay.network.uninstall ] && [ -f "$RELAY_TEST_ROOT/draining" ]; then
    count=$(cat "$RELAY_TEST_ROOT/draining")
    case "$RELAY_TEST_DRAIN" in
        error) exit 5;;
        timeout) exit 0;;
        trash) if [ "$count" = 0 ]; then
            intent="$RELAY_TEST_ROOT/Library/Application Support/Relay/Uninstall/intent.json"
            echo '{}' > "$intent"; /bin/chmod 644 "$intent"
        fi;;
    esac
    if [ "$count" -lt 2 ]; then
        echo $((count + 1)) > "$RELAY_TEST_ROOT/draining"; exit 0
    fi
    rm -f "$RELAY_TEST_ROOT/job-active" "$RELAY_TEST_ROOT/draining"; exit 113
fi
if [ -n "${RELAY_TEST_JOB_ERROR:-}" ]; then exit 1; fi
if [ "$2" = "${RELAY_TEST_JOB:-}" ]; then exit 0; fi
if [ -f "$RELAY_TEST_ROOT/job-active" ] && [ "$2" = system/local.relay.network.uninstall ]; then exit 0; fi
exit 113
''',
            "/bin/ps": 'printf "%s\\n" "${RELAY_TEST_PROCESSES:-}"',
            "/usr/bin/dscl": 'echo fixture-directory-record',
            "/usr/bin/plutil": '''case "$2" in
clientUID) echo "${RELAY_TEST_HELPER_UID:-501}";;
*) printf '%s\\n' "${RELAY_TEST_HOME_OVERRIDE:-$RELAY_TEST_HOME}";; esac''',
            "/usr/bin/codesign": '[ -z "${RELAY_TEST_SIGNATURE_FAILURE:-}" ]',
            "/bin/sleep": 'exit 0',
            "/bin/rm": '''
if [ "$1" = "${RELAY_TEST_UNLINK_FAILURE:-}" ] && [ ! -e "$RELAY_TEST_ROOT/unlink-failed" ]; then
    /usr/bin/touch "$RELAY_TEST_ROOT/unlink-failed"
    exit 19
fi
exec /bin/rm "$@"
''',
        }
        substitutions = {}
        for command, script in tools.items():
            tool = self.root / ("mock-" + Path(command).name)
            self.executable(tool, "#!/bin/sh\n" + script + "\n")
            substitutions[command] = shlex.quote(str(tool))
        for target, name in ((self.preinstall, "app-preinstall"), (self.postinstall, "app-postinstall")):
            source = (INSTALLER / name).read_text()
            for command, replacement in substitutions.items():
                source = source.replace(command + " ", replacement + " ")
            for original in ("in / /Applications;", "in / /Library "):
                source = source.replace(original, original.replace("in / ", f"in {shlex.quote(str(self.root))} "))
            for path in ("/Applications", "/Library"):
                source = source.replace(path, str(self.root) + path)
            for token, filename in (("@SUPERVISOR_SHA256@", "RelayUninstallSupervisor"),
                                    ("@NATIVE_SHA256@", "RelayNative"),
                                    ("@UNINSTALL_DAEMON_SHA256@", "local.relay.network.uninstall.plist")):
                source = source.replace(token, hashlib.sha256((self.root / filename).read_bytes()).hexdigest())
            self.executable(target, source)
        # The transaction has its own real-shell filesystem fixtures. Here keep
        # the monitor publication/rollback tests focused on their entry point.
        self.executable(self.root / "install-transaction", '''#!/bin/sh
case "$1" in
allows-receipt|is-committed) exit 1;;
commit) exit "${RELAY_TEST_COMMIT_FAILURE:-0}";;
reserve-monitor) /bin/mkdir -m 755 "$RELAY_TEST_ROOT/Library/Application Support/Relay/Uninstall";;
retire-backup-for-removal)
    echo retire-removal >> "$RELAY_TEST_TRACE"
    if [ ! -e "$RELAY_TEST_ROOT/job-active" ]; then
        echo bootstrap >> "$RELAY_TEST_TRACE"
        touch "$RELAY_TEST_ROOT/job-active"
    fi;;
rollback-helper)
    echo helper-rollback >> "$RELAY_TEST_TRACE"
    [ -z "${RELAY_TEST_HELPER_ROLLBACK_FAILURE:-}" ] || exit 21;;
rollback)
    if [ -n "${RELAY_TEST_HELPER_ROLLBACK_FAILURE:-}" ]; then echo rollback >> "$RELAY_TEST_TRACE"; fi;;
esac
''')
        for phase in ("preinstall", "postinstall"):
            self.executable(self.root / ("proxy-" + phase),
                            f'#!/bin/sh\nprintf "%s %s %s %s\\n" "{phase}" "$1" "$2" "$3" >> "$RELAY_TEST_TRACE"\n')
        self.executable(self.root / "uninstall", '#!/bin/sh\necho helper-rollback >> "$RELAY_TEST_TRACE"\n')

    def executable(self, file, content):
        file.write_text(content)
        file.chmod(0o755)

    def run_script(self, script, expected=0, volume="/"):
        result = subprocess.run([str(script), "package", volume, volume],
                                env=self.environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result.stderr

    def test_clean_machine_does_not_create_files(self):
        before = set(self.root.iterdir())
        self.run_script(self.preinstall)
        self.assertEqual(set(self.root.iterdir()), before)

    def test_existing_app_or_component_prevents_install(self):
        for target in ("Applications/Relay.app",
                       "Library/Application Support/Relay/SystemProxy",
                       "Library/Application Support/Relay/TunManaged",
                       "Library/Application Support/Relay/Uninstall",
                       "Library/PrivilegedHelperTools/local.relay.network.tun",
                       "Library/LaunchDaemons/local.relay.network.uninstall.plist",
                       "Library/LaunchDaemons/local.relay.network.system-proxy.plist"):
            with self.subTest(target=target):
                stale = self.root / target
                stale.parent.mkdir(parents=True, exist_ok=True)
                stale.symlink_to(self.root / "missing")
                self.assertIn("已有 Relay 安装项", self.run_script(self.preinstall, expected=1))
                self.assertTrue(stale.is_symlink())
                stale.unlink()

    def test_existing_receipt_and_job_prevent_install(self):
        self.environment["RELAY_TEST_RECEIPTS"] = "local.relay.network.app\nlocal.relay.network.tun.core-managed-v2"
        self.assertIn("已有 Relay 安装记录", self.run_script(self.preinstall, expected=1))
        self.environment["RELAY_TEST_RECEIPTS"] = "party.mihomo.helper"
        self.environment["RELAY_TEST_JOB"] = "system/local.relay.network.system-proxy"
        self.assertIn("已有 Relay 服务", self.run_script(self.preinstall, expected=1))
        self.environment["RELAY_TEST_JOB"] = "system/local.relay.network.uninstall"
        self.assertIn("已有 Relay 服务", self.run_script(self.preinstall, expected=1))

    def test_active_zip_prevents_install_without_treating_clash_as_relay(self):
        self.environment["RELAY_TEST_PROCESSES"] = "/Applications/Clash Party.app/Contents/MacOS/Clash Party"
        self.run_script(self.preinstall)
        self.environment["RELAY_TEST_PROCESSES"] += "\n/Users/test/Downloads/Relay.app/Contents/MacOS/Relay"
        self.assertIn("Relay 仍在运行", self.run_script(self.preinstall, expected=1))

    def test_requires_admin_and_startup_volume(self):
        self.environment["RELAY_TEST_UID"] = "501"
        self.assertIn("administrator authorization required", self.run_script(self.preinstall, expected=1))
        self.environment["RELAY_TEST_UID"] = "0"
        self.assertIn("running system volume", self.run_script(self.preinstall, expected=1, volume="/Volumes/Other"))

    def test_unknown_service_status_prevents_install(self):
        self.environment["RELAY_TEST_JOB_ERROR"] = "1"
        self.assertIn("service inventory unavailable", self.run_script(self.preinstall, expected=1))

    def test_helper_reservation_and_publication_keep_installer_arguments(self):
        self.run_script(self.postinstall)
        self.assertEqual(self.trace.read_text().splitlines(), [
            "preinstall package / /", "postinstall package / /",
            f"register --uid 501 --home {self.home}", "bootstrap", "verify-ready"])
        for filename in ("RelayUninstallSupervisor", "RelayNative"):
            self.assertEqual((self.monitor / filename).read_bytes(), (self.root / filename).read_bytes())
            self.assertEqual((self.monitor / filename).stat().st_mode & 0o777, 0o755)
        self.assertTrue((self.monitor / "ready.json").exists())
        self.assertTrue(self.daemon.exists())

    def test_failed_helper_reservation_prevents_publication(self):
        self.executable(self.root / "proxy-preinstall", "#!/bin/sh\nexit 42\n")
        self.executable(self.root / "proxy-postinstall", '#!/bin/sh\ntouch "$RELAY_TEST_TRACE"\n')
        self.run_script(self.postinstall, expected=42)
        self.assertFalse(self.trace.exists())

    def test_missing_console_or_bad_home_refuses_before_installing_helper(self):
        self.environment["RELAY_TEST_CONSOLE_UID"] = "0"
        self.assertIn("ordinary logged-in", self.run_script(self.postinstall, expected=1))
        self.environment["RELAY_TEST_CONSOLE_UID"] = "501"
        self.environment["RELAY_TEST_HOME_OVERRIDE"] = "/var/root"
        self.assertIn("invalid console home", self.run_script(self.postinstall, expected=1))
        self.assertFalse(self.trace.exists())
        self.assertFalse(self.monitor.exists())

    def test_tampered_binary_refuses_before_installing_helper(self):
        with (self.root / "RelayNative").open("a") as stream:
            stream.write("# changed\n")
        self.assertIn("differs from this package", self.run_script(self.postinstall, expected=1))
        self.assertFalse(self.trace.exists())

    def test_helper_account_mismatch_rolls_back_before_monitor_publication(self):
        self.environment["RELAY_TEST_HELPER_UID"] = "502"
        self.assertIn("users differ", self.run_script(self.postinstall, expected=1))
        self.assertEqual(self.trace.read_text().splitlines(), [
            "preinstall package / /", "postinstall package / /", "helper-rollback"])
        self.assertFalse(self.monitor.exists())

    def test_registration_failure_removes_new_monitor_and_rolls_back_helper(self):
        self.environment["RELAY_TEST_REGISTER_FAILURE"] = "1"
        self.run_script(self.postinstall, expected=17)
        self.assertFalse(self.monitor.exists())
        self.assertFalse(self.daemon.exists())
        self.assertEqual(self.trace.read_text().splitlines()[-1], "helper-rollback")
        self.assertNotIn("bootout", self.trace.read_text())
        self.assertNotIn("bootstrap", self.trace.read_text())

    def test_published_staging_unlink_failure_rolls_back_each_pinned_hardlink_pair(self):
        for staging in (".install-supervisor", ".install-native", ".install-daemon"):
            with self.subTest(staging=staging):
                self.environment["RELAY_TEST_UNLINK_FAILURE"] = str(self.monitor / staging)
                self.run_script(self.postinstall, expected=19)
                self.assertFalse(self.monitor.exists())
                self.assertFalse(self.daemon.exists())
                self.assertEqual(self.trace.read_text().splitlines()[-1], "helper-rollback")
                self.assertNotIn("bootstrap", self.trace.read_text())
                (self.root / "unlink-failed").unlink()
                self.trace.unlink()

    def test_bootstrap_failure_removes_new_monitor_and_rolls_back_helper(self):
        self.environment["RELAY_TEST_BOOTSTRAP_FAILURE"] = "1"
        self.run_script(self.postinstall, expected=20)
        self.assertFalse(self.monitor.exists())
        self.assertFalse(self.daemon.exists())
        self.assertEqual(self.trace.read_text().splitlines()[-1], "helper-rollback")
        self.assertNotIn("bootout", self.trace.read_text())

    def test_readiness_failure_is_bounded_and_stops_new_monitor(self):
        self.environment["RELAY_TEST_READY_FAILURE"] = "1"
        self.assertIn("did not acquire", self.run_script(self.postinstall, expected=1))
        trace = self.trace.read_text().splitlines()
        self.assertEqual(trace.count("verify-ready"), 10)
        self.assertEqual(trace[-2:], ["bootout", "helper-rollback"])
        self.assertFalse(self.monitor.exists())
        self.assertFalse(self.daemon.exists())
        self.assertFalse((self.root / "job-active").exists())

    def test_delayed_bootout_waits_for_exact_service_to_disappear(self):
        self.environment.update(RELAY_TEST_READY_FAILURE="1", RELAY_TEST_DRAIN="delay")
        self.run_script(self.postinstall, expected=1)
        self.assertEqual(self.trace.read_text().splitlines()[-2:], ["bootout", "helper-rollback"])
        self.assertFalse(self.monitor.exists())
        self.assertFalse(self.daemon.exists())
        self.assertFalse((self.root / "job-active").exists())

    def test_unconfirmed_helper_rollback_keeps_the_app_transaction(self):
        self.environment.update(RELAY_TEST_READY_FAILURE="1", RELAY_TEST_HELPER_ROLLBACK_FAILURE="1")
        self.run_script(self.postinstall, expected=1)
        trace = self.trace.read_text().splitlines()
        self.assertEqual(trace[-1], "helper-rollback")
        self.assertNotIn("rollback", trace)

    def test_bootout_inventory_error_keeps_new_monitor_for_retry(self):
        self.assert_failed_drain_keeps_monitor("error", "inventory unavailable")

    def test_bootout_timeout_keeps_new_monitor_for_retry(self):
        self.assert_failed_drain_keeps_monitor("timeout", "still registered")

    def assert_failed_drain_keeps_monitor(self, outcome, reason):
        self.environment.update(RELAY_TEST_READY_FAILURE="1", RELAY_TEST_DRAIN=outcome)
        self.assertIn(reason, self.run_script(self.postinstall, expected=1))
        self.assertEqual(self.trace.read_text().splitlines()[-1], "bootout")
        self.assertTrue(self.daemon.exists())
        self.assertTrue((self.monitor / "RelayUninstallSupervisor").exists())
        self.assertTrue((self.root / "job-active").exists())

    def test_trash_during_launchd_drain_restores_the_removal_supervisor(self):
        self.environment.update(RELAY_TEST_READY_FAILURE="1", RELAY_TEST_DRAIN="trash")
        self.assertIn("automatic removal has begun", self.run_script(self.postinstall, expected=1))
        self.assertEqual(self.trace.read_text().splitlines()[-3:], ["bootout", "retire-removal", "bootstrap"])
        self.assertTrue((self.monitor / "intent.json").exists())
        self.assertTrue(self.daemon.exists())
        self.assertTrue((self.root / "job-active").exists())
        self.assertNotIn("helper-rollback", self.trace.read_text())

    def test_committed_backup_cleanup_failure_preserves_complete_new_components(self):
        self.environment["RELAY_TEST_COMMIT_FAILURE"] = "75"
        self.assertIn("installation committed", self.run_script(self.postinstall, expected=75))
        self.assertTrue((self.monitor / "RelayUninstallSupervisor").exists())
        self.assertTrue((self.monitor / "RelayNative").exists())
        self.assertTrue((self.monitor / "ready.json").exists())
        self.assertTrue(self.daemon.exists())
        self.assertTrue((self.root / "job-active").exists())
        self.assertNotIn("bootout", self.trace.read_text())
        self.assertNotIn("helper-rollback", self.trace.read_text())

    def test_removal_during_install_readiness_keeps_its_durable_cleanup_owner(self):
        self.environment["RELAY_TEST_REMOVAL_DURING_READY"] = "1"
        output = self.run_script(self.postinstall, expected=1)
        self.assertIn("automatic removal has begun", output)
        self.assertTrue((self.monitor / "intent.json").exists())
        self.assertTrue((self.monitor / "RelayNative").exists())
        self.assertTrue((self.monitor / "installation.json").exists())
        self.assertTrue(self.daemon.exists())
        self.assertTrue((self.root / "job-active").exists())
        self.assertNotIn("bootout", self.trace.read_text())
        self.assertNotIn("helper-rollback", self.trace.read_text())


class SupervisorPackageTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("integrated_installer", APP / "scripts/relay/build-integrated-installer.py")
        self.builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.builder)
        self.temporary = tempfile.TemporaryDirectory(prefix="relay-monitor-build-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "RelayUninstallSupervisor").write_bytes(b"fixture universal executable")
        self.daemon = self.root / "local.relay.network.uninstall.plist"
        self.daemon.write_bytes(plistlib.dumps({
            "Label": "local.relay.network.uninstall", "RunAtLoad": True,
            "ProgramArguments": ["/Library/Application Support/Relay/Uninstall/RelayUninstallSupervisor"]}))
        self.source = "scripts/relay/test-integrated-installer.py"
        self.receipt = {
            "passed": True, "architectures": ["arm64", "x86_64"],
            "supervisorSHA256": self.builder.digest(self.root / "RelayUninstallSupervisor"),
            "daemonSHA256": self.builder.digest(self.daemon),
            "sourceSHA256": {self.source: self.builder.digest(APP / self.source)}}
        self.write_receipt()
        patch = mock.patch.object(self.builder, "run", side_effect=lambda *args: "x86_64 arm64" if args[0] == "/usr/bin/lipo" else "")
        patch.start()
        self.addCleanup(patch.stop)

    def write_receipt(self):
        (self.root / "build-receipt.json").write_text(json.dumps(self.receipt))

    def test_installer_version_contains_the_app_build_without_changing_short_version(self):
        info = {"CFBundleShortVersionString": "1.0.0", "CFBundleVersion": "12"}
        self.assertEqual(self.builder.installer_version(info, "1.0.0"), "1.0.0.12")
        for build in [None, 12, "0", "012", "12.1", "12-beta", "9999999999"]:
            with self.subTest(build=build), self.assertRaisesRegex(RuntimeError, "CFBundleVersion"):
                self.builder.installer_version({**info, "CFBundleVersion": build}, "1.0.0")
        with self.assertRaisesRegex(RuntimeError, "release versions differ"):
            self.builder.installer_version(info, "1.0.1")

    def test_verified_monitor_receipt_is_accepted(self):
        self.assertEqual(self.builder.verify_uninstall_build(self.root), self.receipt)

    def test_changed_binary_and_stale_source_are_rejected(self):
        (self.root / "RelayUninstallSupervisor").write_bytes(b"changed")
        with self.assertRaisesRegex(RuntimeError, "build differs"):
            self.builder.verify_uninstall_build(self.root)
        self.receipt["supervisorSHA256"] = self.builder.digest(self.root / "RelayUninstallSupervisor")
        self.receipt["sourceSHA256"][self.source] = "0" * 64
        self.write_receipt()
        with self.assertRaisesRegex(RuntimeError, "source changed"):
            self.builder.verify_uninstall_build(self.root)

    def test_untrusted_daemon_path_is_rejected_even_with_matching_digest(self):
        daemon = plistlib.loads(self.daemon.read_bytes())
        daemon["ProgramArguments"] = ["/tmp/RelayUninstallSupervisor"]
        self.daemon.write_bytes(plistlib.dumps(daemon))
        self.receipt["daemonSHA256"] = self.builder.digest(self.daemon)
        self.write_receipt()
        with self.assertRaisesRegex(RuntimeError, "Unexpected uninstall"):
            self.builder.verify_uninstall_build(self.root)


class TunPackageTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("integrated_tun", APP / "scripts/relay/build-integrated-installer.py")
        self.builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.builder)
        self.temporary = tempfile.TemporaryDirectory(prefix="relay-tun-pkg-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.app = self.root / "Relay.app"
        self.compiled = self.root / "compiled"
        self.compiled.mkdir()
        self.scripts = self.root / "scripts"
        self.scripts.mkdir()
        self.client = self.compiled / "RelayTunClient"
        self.client.write_bytes(b"fixture universal TUN client")
        self.client.chmod(0o755)
        self.pin = {"sha256": self.builder.digest(self.client), "size": self.client.stat().st_size,
                    "cdhashes": {"arm64": "a" * 40, "x86_64": "b" * 40}}
        names = ["RelayTunManagedCore", "RelayTunOwnedChild", "RelayTunExecutionReceiptV2", "RelayTunHelperTrust"]
        sources = {}
        for name in names:
            path = self.root / "native/tun" / (name + ".swift")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture source " + name)
            sources[str(path.relative_to(self.root))] = self.builder.digest(path)
        (self.compiled / "shipping-sources.json").write_text(json.dumps({"version": 1, "files": sources}))
        self.pins = self.root / "src/main/relay/tun"
        self.pins.mkdir(parents=True)
        for name in ["execution-client.json", "runtime-resources-client.json"]:
            (self.pins / name).write_text(json.dumps({"clientSHA256": self.pin["sha256"]}))
        self.profile = {"capability": "local-geodata-v1", "implementationRevision": 2, "assets": {}}
        for arch in ["arm64", "x64"]:
            path = self.app / "Contents/Resources/relay/core-geodata-v1" / ("darwin-" + arch + "/mihomo")
            path.parent.mkdir(parents=True)
            path.write_bytes(("fixture " + arch).encode())
            path.chmod(0o755)
            self.profile["assets"][arch] = {"path": "darwin-" + arch + "/mihomo", "sha256": self.builder.digest(path), "size": path.stat().st_size}
        (self.app / "Contents/Resources/app.asar").write_bytes(b"fixture sealed App archive")
        self.admission = {"passed": True, "applicationCodeExecuted": False,
                          "clientSHA256": self.pin["sha256"],
                          "appASARSHA256": self.builder.digest(self.app / "Contents/Resources/app.asar"),
                          "cores": {native: {key: self.profile["assets"][arch][key] for key in ["sha256", "size"]}
                                    for arch, native in [("arm64", "arm64"), ("x64", "x86_64")]}}
        self.manifest = self.root / "src/main/relay/core/geodata-manifest.json"
        self.manifest.parent.mkdir()
        self.manifest.write_text(json.dumps(self.profile))
        remover = self.root / "native/installer/package/tun-uninstall"
        remover.parent.mkdir(parents=True)
        remover.write_text("#!/bin/sh\n# fixture remover\n")
        self.builder.APP = self.root
        patches = [
            mock.patch.object(self.builder, "load_builder", side_effect=lambda name: mock.Mock(
                code_pin=mock.Mock(return_value=self.pin), uninstaller_for_profile=mock.Mock(return_value="#!/usr/bin/python3\n# fixture remover\n"))),
            mock.patch.object(self.builder, "run", side_effect=lambda *args:
                              ("arm64" if "darwin-arm64" in str(args[-1]) else "x86_64") if args[0] == "/usr/bin/lipo"
                              else json.dumps(self.admission) if args[0] == "node" else ""),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def test_single_package_contains_unbound_template_and_both_fixed_cores(self):
        receipt = self.builder.stage_tun(self.app, self.compiled, self.scripts)
        template = json.loads((self.scripts / "tun-installation.template.json").read_text())
        self.assertEqual(template["clientUID"], 0)
        self.assertEqual(template["role"], "core-managed-v2")
        self.assertEqual(set(template["cores"]), {"arm64", "x86_64"})
        self.assertTrue(receipt["clientUIDBoundAtInstall"])
        self.assertEqual(template["client"], self.pin)
        self.assertTrue((self.scripts / "tun-uninstall.py").read_text().startswith("#!/bin/sh\n"))

    def test_stale_native_source_is_rejected_before_staging(self):
        (self.root / "native/tun/RelayTunOwnedChild.swift").write_text("changed")
        with self.assertRaisesRegex(RuntimeError, "source changed"):
            self.builder.stage_tun(self.app, self.compiled, self.scripts)
        self.assertFalse((self.scripts / "RelayTunClient").exists())

    def test_mismatched_capability_or_core_is_rejected(self):
        pin = self.pins / "runtime-resources-client.json"
        pin.write_text(json.dumps({"clientSHA256": "0" * 64}))
        with self.assertRaisesRegex(RuntimeError, "capability pin"):
            self.builder.stage_tun(self.app, self.compiled, self.scripts)
        pin.write_text(json.dumps({"clientSHA256": self.pin["sha256"]}))
        core = self.app / "Contents/Resources/relay/core-geodata-v1/darwin-x64/mihomo"
        core.write_bytes(b"different Intel core")
        with self.assertRaisesRegex(RuntimeError, "paired fixed TUN Core: x64"):
            self.builder.stage_tun(self.app, self.compiled, self.scripts)

    def test_sealed_app_admission_must_match_native_payload(self):
        self.admission["clientSHA256"] = "0" * 64
        with self.assertRaisesRegex(RuntimeError, "Sealed App TUN admission proof differs"):
            self.builder.stage_tun(self.app, self.compiled, self.scripts)
        self.assertFalse((self.scripts / "RelayTunClient").exists())

    def test_old_build_without_fixed_stack_revision_is_rejected(self):
        self.profile.pop("implementationRevision")
        self.manifest.write_text(json.dumps(self.profile))
        with self.assertRaisesRegex(RuntimeError, "Mixed/gVisor"):
            self.builder.stage_tun(self.app, self.compiled, self.scripts)


if __name__ == "__main__":
    unittest.main()
