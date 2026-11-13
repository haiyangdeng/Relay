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
    rm -f "$RELAY_TEST_ROOT/job-active"
    exit 0;;
esac
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
        self.assertEqual(self.trace.read_text().splitlines()[-2:], ["bootout", "helper-rollback"])
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
        self.assertEqual(self.trace.read_text().splitlines()[-2:], ["bootout", "helper-rollback"])

    def test_readiness_failure_is_bounded_and_stops_new_monitor(self):
        self.environment["RELAY_TEST_READY_FAILURE"] = "1"
        self.assertIn("did not acquire", self.run_script(self.postinstall, expected=1))
        trace = self.trace.read_text().splitlines()
        self.assertEqual(trace.count("verify-ready"), 10)
        self.assertEqual(trace[-2:], ["bootout", "helper-rollback"])
        self.assertFalse(self.monitor.exists())
        self.assertFalse(self.daemon.exists())
        self.assertFalse((self.root / "job-active").exists())

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


if __name__ == "__main__":
    unittest.main()
