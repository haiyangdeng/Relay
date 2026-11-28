#!/usr/bin/env python3
"""Real shell/flock/atomic-rename fixtures; no administrator or system actions."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shlex
import subprocess
import sys
import tempfile
import unittest

APP = Path(__file__).resolve().parents[2]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="relay-transaction-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.environment = {**os.environ, "RELAY_FIXTURE_ROOT": str(self.root), "RELAY_FIXTURE_BOOKMARK_VERIFIED": "yes"}
        self.app = self.root / "Applications/Relay.app"
        self.relay = self.root / "Library/Application Support/Relay"
        self.transaction = self.relay / "InstallerTransaction"
        self.scripts = self.root / "scripts"
        self.scripts.mkdir()
        for name in ["Applications", "Library/Application Support/Relay", "Library/LaunchDaemons", "Library/PrivilegedHelperTools"]:
            (self.root / name).mkdir(parents=True, exist_ok=True)
        self.write(self.scripts / "RelayTunClient", b"new client", 0o755)
        self.write(self.scripts / "tun-uninstall.py", b"new remover", 0o755)
        self.template = {
            "version": 2, "role": "core-managed-v2", "coreProfile": "local-geodata-v1", "clientUID": 0,
            "client": {"sha256": sha(self.scripts / "RelayTunClient")},
            "uninstallerSHA256": sha(self.scripts / "tun-uninstall.py"),
            "cores": {name: {"sha256": hashlib.sha256(("new " + name).encode()).hexdigest()} for name in ["arm64", "x86_64"]}}
        self.json(self.scripts / "tun-installation.template.json", self.template)
        self.proxy_remover = ("#!/bin/sh\n/bin/rm " + " ".join(shlex.quote(str(path)) for path in [
            self.relay / "SystemProxy/installation.json", self.relay / "SystemProxy/RelaySystemProxyClient",
            self.relay / "SystemProxy/uninstall", self.root / "Library/PrivilegedHelperTools/local.relay.network.system-proxy",
            self.root / "Library/LaunchDaemons/local.relay.network.system-proxy.plist"]) +
            "\n/bin/rmdir " + shlex.quote(str(self.relay / "SystemProxy")) + "\n").encode()
        self.json(self.scripts / "installation.template.json", {"uninstallerSHA256": hashlib.sha256(self.proxy_remover).hexdigest(),
                  "daemonSHA256": hashlib.sha256(b"new proxy local.relay.network.system-proxy.plist").hexdigest()})
        # Model the separately tested native identity verifier's accept/refuse results.
        self.verifier = b'#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = --verify-installed-identity ] && [ "${RELAY_FIXTURE_BOOKMARK_VERIFIED:-}" = yes ]\n'
        self.write(self.scripts / "RelayUninstallSupervisor", self.verifier, 0o755)
        self.plan = {"version": 1, "appExecutableSHA256": hashlib.sha256(b"new app").hexdigest(),
                     "appASARSHA256": hashlib.sha256(b"new javascript").hexdigest(),
                     "tunTemplateSHA256": sha(self.scripts / "tun-installation.template.json"),
                     "proxyHelperSHA256": hashlib.sha256(b"new proxy helper").hexdigest(),
                     "proxyTemplateSHA256": sha(self.scripts / "installation.template.json"),
                     "supervisorSHA256": sha(self.scripts / "RelayUninstallSupervisor"),
                     "nativeSHA256": hashlib.sha256(b"RelayNative").hexdigest(),
                     "daemonSHA256": hashlib.sha256(b"local.relay.network.uninstall.plist").hexdigest()}
        self.json(self.scripts / "install-plan.json", self.plan)
        tools = {
            "/usr/bin/id": '''case "$1:${2:-}" in
-u:) echo 0;; -nu:*) echo fixture;; -u:fixture) echo "${RELAY_FIXTURE_UID:-501}";; *) exit 1;; esac''',
            "/usr/bin/stat": '''case "$2" in
%d:%i:%u:%Lp:%l:%z|%i:%u:%Lp:%l:%z) [ "${RELAY_FIXTURE_STAT_IDENTITY_FAIL:-}" != 1 ] || exit 31;;
esac
case "$2" in
%u) case "$3" in /dev/console) echo "${RELAY_FIXTURE_UID:-501}";; *) if [ "$3" = "${RELAY_FIXTURE_FOREIGN_DIR:-}" ]; then echo 501; else echo 0; fi;; esac;;
%u:%l) printf '0:%s\\n' "$(/usr/bin/stat -f '%l' "$3")";;
%u:%Lp:%l) printf '0:%s\\n' "$(/usr/bin/stat -f '%Lp:%l' "$3")";;
*) exec /usr/bin/stat "$@";; esac''',
            "/usr/bin/lockf": '''/usr/bin/lockf "$@" || exit $?
lock="$RELAY_FIXTURE_ROOT/Library/Application Support/Relay/TunManaged/busy.lock"
if [ -n "${RELAY_FIXTURE_LOCK_MUTATION:-}${RELAY_FIXTURE_STAT_IDENTITY_FAIL:-}" ]; then
    ''' + shlex.quote(sys.executable) + ''' - "$lock" <<'PY'
import fcntl, sys
with open(sys.argv[1], "rb") as contender:
    try:
        fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        pass
    else:
        raise SystemExit("fixture expected the shell to retain its lifetime lock")
PY
    [ "$?" = 0 ] || exit 32
fi
case "${RELAY_FIXTURE_LOCK_MUTATION:-}" in
replace)
    /bin/mv "$lock" "$RELAY_FIXTURE_ROOT/held-busy.lock" || exit $?
    /bin/cat "$RELAY_FIXTURE_ROOT/held-busy.lock" > "$lock" || exit $?
    /bin/chmod 644 "$lock";;
chmod) /bin/chmod 600 "$lock";;
esac''',
            "/usr/bin/codesign": '[ -z "${RELAY_FIXTURE_BAD_SIGNATURE:-}" ]',
            "/bin/ps": '''if [ -f "$RELAY_FIXTURE_ROOT/started-after-move" ]; then echo /Applications/Relay.app/Contents/MacOS/Relay; else printf "%s\\n" "${RELAY_FIXTURE_PROCESSES:-}"; fi''',
            "/usr/sbin/pkgutil": 'printf "%s\\n" "${RELAY_FIXTURE_RECEIPTS:-}"',
            "/bin/sleep": ':',
            "/bin/launchctl": '''
case "$1" in
print)
    job="$RELAY_FIXTURE_ROOT/job-${2##*/}"; pending="$job-bootout"
    if [ -f "$pending" ]; then
        count=$(/bin/cat "$pending")
        case "$count" in
            stuck) exit 0;;
            unknown) exit 5;;
            0) /bin/rm "$pending" "$job"; exit 113;;
            *) echo "$((count - 1))" > "$pending"; exit 0;;
        esac
    fi
    [ -f "$job" ] && exit 0; exit 113;;
bootout) printf 'bootout %s\\n' "$2" >> "$RELAY_FIXTURE_ROOT/trace"; job="$RELAY_FIXTURE_ROOT/job-${2##*/}"
    if [ -n "${RELAY_FIXTURE_BOOTOUT_DELAY:-}" ]; then echo "$RELAY_FIXTURE_BOOTOUT_DELAY" > "$job-bootout"
    else /bin/rm "$job"; fi
    if [ "$2" = system/local.relay.network.uninstall ] && [ -n "${RELAY_FIXTURE_APP_AT_BOOTOUT:-}" ]; then
        /bin/mv "$RELAY_FIXTURE_ROOT/Applications/Relay.app" "$RELAY_FIXTURE_ROOT/moved-original"
        if [ "$RELAY_FIXTURE_APP_AT_BOOTOUT" = replacement ]; then /bin/mv "$RELAY_FIXTURE_ROOT/replacement" "$RELAY_FIXTURE_ROOT/Applications/Relay.app"; fi
    fi;;
bootstrap) name=${3##*/}; name=${name%.plist}; printf 'bootstrap %s\\n' "$name" >> "$RELAY_FIXTURE_ROOT/trace"; /usr/bin/touch "$RELAY_FIXTURE_ROOT/job-$name";;
*) exit 1;; esac''',
            "/bin/mv": '''
if [ -n "${RELAY_FIXTURE_REPLACE_AT_RENAME:-}" ] && [ "$1" = "$RELAY_FIXTURE_ROOT/Applications/Relay.app" ]; then
    /bin/mv "$1" "$RELAY_FIXTURE_ROOT/moved-original"
    /bin/mv "$RELAY_FIXTURE_ROOT/replacement" "$1"
fi
if [ "$1" = "${RELAY_FIXTURE_MOVE_FAILURE:-}" ] && [ ! -e "$RELAY_FIXTURE_ROOT/move-failed" ]; then
    /usr/bin/touch "$RELAY_FIXTURE_ROOT/move-failed"; exit 23
fi
/bin/mv "$@" || exit $?
if [ -n "${RELAY_FIXTURE_START_AFTER_MOVE:-}" ] && [ "$1" = "$RELAY_FIXTURE_ROOT/Applications/Relay.app" ]; then /usr/bin/touch "$RELAY_FIXTURE_ROOT/started-after-move"; fi''',
            "/bin/rm": '''
if [ -n "${RELAY_FIXTURE_COMMIT_CLEANUP_FAILURE:-}" ] && [ "$1" = -rf ] && [ "$2" = "$RELAY_FIXTURE_ROOT/Library/Application Support/Relay/InstallerTransaction/old" ]; then
    /bin/rm "$2/app/Contents/MacOS/Relay"; exit 27
fi
exec /bin/rm "$@"''',
            "/bin/cat": '''
if [ "$1" = "${RELAY_FIXTURE_COPY_FAILURE:-}" ]; then printf 'partial'; exit 24; fi
exec /bin/cat "$@"''',
        }
        source = (APP / "native/installer/package/install-transaction").read_text()
        self.substitutions = {}
        for command, body in tools.items():
            tool = self.root / ("mock-" + Path(command).name)
            self.write(tool, ("#!/bin/sh\n" + body + "\n").encode(), 0o755)
            self.substitutions[command] = shlex.quote(str(tool))
            source = source.replace(command + " ", shlex.quote(str(tool)) + " ")
        source = source.replace("in / /Library ", "in " + shlex.quote(str(self.root)) + " /Library ")
        for path in ["/Applications", "/Library"]:
            source = source.replace(path, str(self.root) + path)
        source = source.replace("@INSTALL_PLAN_SHA256@", sha(self.scripts / "install-plan.json"))
        self.command = self.scripts / "install-transaction"
        self.write(self.command, source.encode(), 0o755)
        subprocess.run(["/bin/sh", "-n", self.command], check=True)

    def write(self, path, data, mode=0o644):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(mode)

    def json(self, path, value):
        self.write(path, (json.dumps(value, separators=(",", ":")) + "\n").encode())

    def run_action(self, action, *arguments, expected=0):
        result = subprocess.run([self.command, action, *arguments], env=self.environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def prepare(self, expected=0):
        return self.run_action("prepare", "package", "/", "/", expected=expected)

    def make_app(self, old=False):
        self.write(self.app / "Contents/Info.plist", plistlib.dumps({"CFBundleIdentifier": "local.relay.network.preview", "CFBundleExecutable": "Relay"}))
        self.write(self.app / "Contents/MacOS/Relay", b"old app" if old else b"new app", 0o755)
        self.write(self.app / "Contents/Resources/app.asar", b"old javascript" if old else b"new javascript")
        for arch, name in [("arm64", "arm64"), ("x64", "x86_64")]:
            self.write(self.app / ("Contents/Resources/relay/core-geodata-v1/darwin-" + arch + "/mihomo"), ("new " + name).encode(), 0o755)

    def make_proxy(self, old=False, uid=501):
        base = self.relay / "SystemProxy"
        helper = self.root / "Library/PrivilegedHelperTools/local.relay.network.system-proxy"
        daemon = self.root / "Library/LaunchDaemons/local.relay.network.system-proxy.plist"
        for file in [base / "RelaySystemProxyClient", base / "uninstall", helper, daemon]:
            self.write(file, (("old" if old else "new") + " proxy " + ("helper" if file == helper else file.name)).encode(), 0o644 if file == daemon else 0o755)
        if not old:
            self.write(base / "uninstall", self.proxy_remover, 0o755)
        self.json(base / "installation.json", {"version": 1, "role": "system-proxy-v1", "clientUID": uid,
                  "client": {"sha256": sha(base / "RelaySystemProxyClient")}, "helper": {"sha256": sha(helper)},
                  "uninstallerSHA256": sha(base / "uninstall"), "daemonSHA256": sha(daemon)})

    def make_monitor(self, uid=501):
        if self.transaction.exists() and not (self.relay / "Uninstall").exists():
            self.run_action("reserve-monitor")
        base = self.relay / "Uninstall"
        daemon = self.root / "Library/LaunchDaemons/local.relay.network.uninstall.plist"
        for file in [base / "RelayUninstallSupervisor", base / "RelayNative", daemon]:
            self.write(file, self.verifier if file.name == "RelayUninstallSupervisor" else file.name.encode(), 0o644 if file == daemon else 0o755)
        self.json(base / "installation.json", {"clientUID": uid, "generation": "fixture-generation",
                  "supervisorSHA256": sha(base / "RelayUninstallSupervisor"), "nativeSHA256": sha(base / "RelayNative"),
                  "daemonSHA256": sha(daemon), "appExecutableSHA256": sha(self.app / "Contents/MacOS/Relay"),
                  "appDevice": self.app.stat().st_dev, "appInode": self.app.stat().st_ino})

    def make_old(self, tun=True, uid=501):
        self.make_app(old=True)
        self.make_proxy(old=True, uid=uid)
        self.make_monitor(uid=uid)
        if tun:
            base = self.relay / "TunManaged"
            manifest = json.loads(json.dumps(self.template))
            manifest["clientUID"] = uid
            for name, pin, mode in [("RelayTunClient", manifest["client"]["sha256"], 0o755), ("uninstall.py", manifest["uninstallerSHA256"], 0o755)]:
                source = self.scripts / ("tun-uninstall.py" if name == "uninstall.py" else name)
                self.write(base / name, source.read_bytes(), mode)
            for arch, key in [("arm64", "arm64"), ("x64", "x86_64")]:
                self.write(base / ("Core/darwin-" + arch + "/mihomo"), ("new " + key).encode(), 0o4755)
            self.write(base / "busy.lock", b"Relay core-managed TUN v1\n")
            self.json(base / "installation.json", manifest)
        for service in ["system-proxy", "uninstall"]:
            (self.root / ("job-local.relay.network." + service)).touch()
        self.environment["RELAY_FIXTURE_RECEIPTS"] = "local.relay.network.app\nlocal.relay.network.system-proxy.v1\nlocal.relay.network.tun.core-managed-v2"

    def stage_shell_remover(self):
        source = (APP / "native/installer/package/tun-uninstall").read_text()
        for command, replacement in self.substitutions.items():
            source = source.replace(command + " ", replacement + " ")
        source = source.replace("in / /Library ", "in " + shlex.quote(str(self.root)) + " /Library ")
        source = source.replace("/Library", str(self.root) + "/Library")
        remover = self.relay / "TunManaged/uninstall.py"
        self.write(remover, source.encode(), 0o755)
        path = self.relay / "TunManaged/installation.json"
        manifest = json.loads(path.read_text())
        manifest["uninstallerSHA256"] = sha(remover)
        self.json(path, manifest)
        return remover, sha(path)

    def test_shell_remover_handles_shared_package_without_python(self):
        self.make_old()
        remover, reviewed = self.stage_shell_remover()
        result = subprocess.run([remover, "--remove", reviewed], env=self.environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.relay / "TunManaged").exists())
        self.assertTrue(self.app.exists())
        self.assertTrue((self.relay / "SystemProxy").exists())
        self.assertFalse((self.root / "trace").exists())

    def test_shell_remover_rejects_busy_changed_manifest_and_unknown_files(self):
        import fcntl
        self.make_old()
        remover, reviewed = self.stage_shell_remover()
        def run(digest):
            return subprocess.run([remover, "--remove", digest], env=self.environment, capture_output=True, text=True)
        result = run("0" * 64)
        self.assertEqual(result.returncode, 1)
        self.assertIn("manifest identity mismatch", result.stderr)
        with (self.relay / "TunManaged/busy.lock").open() as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = run(reviewed)
            self.assertEqual(result.returncode, 1)
            self.assertIn("still active", result.stderr)
        self.write(self.relay / "TunManaged/foreign", b"not ours")
        result = run(reviewed)
        self.assertEqual(result.returncode, 1)
        self.assertIn("unknown component", result.stderr)
        self.assertTrue((self.relay / "TunManaged/installation.json").exists())

    def test_clean_volume_creates_helper_parent_only_during_prepare(self):
        parent = self.root / "Library/PrivilegedHelperTools"
        parent.rmdir()
        self.run_action("verify", expected=1)
        self.run_action("prepare", "package", "/", "/Volumes/Other", expected=1)
        self.assertFalse(parent.exists())
        self.prepare()
        self.assertEqual(parent.stat().st_mode & 0o7777, 0o755)
        self.run_action("verify")
        self.run_action("rollback")
        self.assertTrue(parent.is_dir())

    def test_existing_helper_parent_preserves_mode_inode_and_unrelated_helpers(self):
        parent = self.root / "Library/PrivilegedHelperTools"
        parent.chmod(0o750)
        unrelated = parent / "third-party-helper"
        self.write(unrelated, b"third-party")
        before = parent.stat()
        self.prepare()
        self.run_action("rollback")
        self.assertEqual((parent.stat().st_ino, parent.stat().st_mode), (before.st_ino, before.st_mode))
        self.assertEqual(unrelated.read_bytes(), b"third-party")

    def test_unsafe_helper_parent_fails_before_transaction(self):
        parent = self.root / "Library/PrivilegedHelperTools"
        for case in ["foreign", "writable", "linked", "dangling", "file"]:
            with self.subTest(case=case):
                if case == "foreign":
                    self.environment["RELAY_FIXTURE_FOREIGN_DIR"] = str(parent)
                elif case == "writable":
                    parent.chmod(0o777)
                else:
                    parent.rmdir()
                    if case == "file":
                        parent.touch()
                    else:
                        parent.symlink_to(self.root if case == "linked" else self.root / "missing")
                message = self.prepare(expected=1)
                self.assertIn(str(parent), message)
                self.assertFalse(self.transaction.exists())
                if parent.is_symlink() or parent.is_file():
                    parent.unlink()
                    parent.mkdir()
                self.environment.pop("RELAY_FIXTURE_FOREIGN_DIR", None)
                parent.chmod(0o755)

    def test_fresh_binds_actual_console_uid_and_commits_both_components(self):
        self.environment["RELAY_FIXTURE_UID"] = "502"
        self.environment["RELAY_TUN_UID"] = "501"  # Caller-selected UID is ignored.
        self.prepare()
        self.make_app()
        self.make_proxy(uid=502)
        self.run_action("publish-tun")
        self.make_monitor(uid=502)
        self.run_action("commit")
        manifest = json.loads((self.relay / "TunManaged/installation.json").read_text())
        self.assertEqual(manifest["clientUID"], 502)
        self.assertEqual((self.relay / "TunManaged/Core/darwin-arm64/mihomo").stat().st_mode & 0o7777, 0o4755)
        self.assertFalse(self.transaction.exists())
        self.assertFalse((self.root / "trace").exists())

    def test_upgrade_preserves_old_inode_until_commit_and_user_files(self):
        self.make_old()
        inode = self.app.stat().st_ino
        private = self.root / "Users/test/Library/Application Support/Relay-Preview/profile.yaml"
        self.write(private, b"private profile")
        self.prepare()
        self.assertFalse(self.app.exists())
        self.assertEqual((self.transaction / "old/app").stat().st_ino, inode)
        self.run_action("allows-receipt", "local.relay.network.system-proxy.v1")
        self.make_app()
        self.make_proxy()
        self.run_action("publish-tun")
        self.make_monitor()
        self.run_action("commit")
        self.assertEqual(private.read_bytes(), b"private profile")
        self.assertFalse(self.transaction.exists())
        self.assertEqual((self.root / "trace").read_text().splitlines(), ["bootout system/local.relay.network.uninstall", "bootout system/local.relay.network.system-proxy"])

    def test_upgrade_waits_for_both_old_registrations_to_disappear(self):
        self.make_old()
        inode = self.app.stat().st_ino
        self.environment["RELAY_FIXTURE_BOOTOUT_DELAY"] = "3"
        self.prepare()
        self.assertEqual((self.transaction / "old/app").stat().st_ino, inode)
        self.assertFalse(list(self.root.glob("job-*")))
        self.run_action("rollback")
        self.assertEqual(self.app.stat().st_ino, inode)
        for name in ["uninstall", "system-proxy"]:
            self.assertTrue((self.root / ("job-local.relay.network." + name)).exists())
        self.assertFalse(self.transaction.exists())

    def test_unconfirmed_old_stop_retains_recovery_and_never_moves_old_app(self):
        self.make_old()
        inode = self.app.stat().st_ino
        self.environment["RELAY_FIXTURE_BOOTOUT_DELAY"] = "stuck"
        self.assertIn("still registered after bootout", self.prepare(expected=1))
        self.assertEqual(self.app.stat().st_ino, inode)
        self.assertFalse((self.transaction / "old/app").exists())
        self.assertEqual(plistlib.loads((self.transaction / "state.plist").read_bytes())["oldServiceStop"], "monitor:accepted")
        pending = self.root / "job-local.relay.network.uninstall-bootout"
        pending.write_text("unknown")
        self.assertIn("service inventory", self.run_action("rollback", expected=1))
        self.assertTrue(self.transaction.exists())
        self.assertEqual((self.root / "trace").read_text().splitlines(), ["bootout system/local.relay.network.uninstall"])
        pending.write_text("1")
        self.run_action("rollback")
        self.assertTrue((self.root / "job-local.relay.network.uninstall").exists())
        self.assertEqual((self.root / "trace").read_text().splitlines()[-1], "bootstrap local.relay.network.uninstall")
        self.assertEqual(self.app.stat().st_ino, inode)
        self.assertFalse(self.transaction.exists())

    def test_missing_legacy_stop_field_reconciles_jobs_before_releasing_rollback(self):
        self.make_old()
        self.environment["RELAY_FIXTURE_BOOTOUT_DELAY"] = "stuck"
        self.prepare(expected=1)
        current = self.transaction / "state.plist"
        data = plistlib.loads(current.read_bytes())
        for name in ["oldServiceStop", "oldMonitorGeneration"]:
            del data[name]
        current.write_bytes(plistlib.dumps(data))
        (self.root / "job-local.relay.network.uninstall-bootout").write_text("0")
        self.environment["RELAY_FIXTURE_BOOTOUT_DELAY"] = "2"
        self.run_action("rollback")
        self.assertFalse(self.transaction.exists())
        for name in ["system-proxy", "uninstall"]:
            self.assertTrue((self.root / ("job-local.relay.network." + name)).exists())

    def test_old_monitor_removal_accepted_during_unregister_survives_retry(self):
        self.make_old()
        self.environment["RELAY_FIXTURE_BOOTOUT_DELAY"] = "stuck"
        self.prepare(expected=1)
        self.app.rename(self.root / "moved-to-trash")
        monitor = self.relay / "Uninstall"
        intent = monitor / "intent.json"
        self.json(intent, {"generation": "other-generation", "clientUID": 501})
        self.assertIn("removal generation differs", self.run_action("rollback", expected=1))
        self.assertTrue(self.transaction.exists())
        self.json(intent, {"generation": "fixture-generation", "clientUID": 501})
        (self.root / "job-local.relay.network.uninstall-bootout").write_text("0")
        self.assertIn("accepted removal", self.prepare(expected=1))
        self.assertFalse(self.transaction.exists())
        self.assertTrue(intent.exists())
        self.assertTrue((monitor / "RelayUninstallSupervisor").exists())
        self.assertTrue((self.root / "job-local.relay.network.uninstall").exists())
        self.assertFalse(self.app.exists())

    def test_rollback_waits_for_this_packages_proxy_helper_before_removal(self):
        self.make_old()
        self.prepare()
        self.make_app()
        self.make_proxy()
        job = self.root / "job-local.relay.network.system-proxy"
        job.touch()
        self.environment["RELAY_FIXTURE_BOOTOUT_DELAY"] = "3"
        self.run_action("rollback-helper")
        self.assertFalse((self.relay / "SystemProxy").exists())
        self.assertFalse(job.exists())
        self.run_action("rollback")
        self.assertTrue(job.exists())
        self.assertEqual((self.root / "Library/PrivilegedHelperTools/local.relay.network.system-proxy").read_bytes(), b"old proxy helper")

    def test_failed_new_monitor_cleanup_preserves_binaries_until_job_is_absent(self):
        self.make_old()
        self.prepare()
        self.make_app()
        self.make_monitor()
        self.run_action("record-monitor")
        job = self.root / "job-local.relay.network.uninstall"
        job.touch()
        self.environment["RELAY_FIXTURE_BOOTOUT_DELAY"] = "unknown"
        self.assertIn("service inventory", self.run_action("rollback-monitor", expected=1))
        self.assertTrue((self.relay / "Uninstall/RelayUninstallSupervisor").exists())
        self.assertTrue(self.transaction.exists())
        self.environment["RELAY_FIXTURE_BOOTOUT_DELAY"] = "3"
        Path(str(job) + "-bootout").write_text("0")
        self.run_action("rollback-monitor")
        self.assertFalse((self.relay / "Uninstall").exists())
        self.assertFalse(job.exists())

    def test_remounted_app_uses_packaged_identity_verifier_before_upgrade(self):
        self.make_old()
        path = self.relay / "Uninstall/installation.json"
        registration = json.loads(path.read_text())
        registration["appDevice"] += 1
        self.json(path, registration)
        self.environment["RELAY_FIXTURE_BOOKMARK_VERIFIED"] = "no"
        self.assertIn("bookmark or volume", self.prepare(expected=1))
        self.assertFalse(self.transaction.exists())
        self.assertTrue(self.app.exists())
        self.environment["RELAY_FIXTURE_BOOKMARK_VERIFIED"] = "yes"
        self.prepare()
        self.assertTrue((self.transaction / "old/app").is_dir())

    def test_same_mount_number_still_requires_original_bookmark(self):
        self.make_old()
        self.environment["RELAY_FIXTURE_BOOKMARK_VERIFIED"] = "no"
        self.assertIn("bookmark or volume", self.prepare(expected=1))
        self.assertFalse(self.transaction.exists())
        self.assertTrue(self.app.is_dir())

    def test_original_app_moved_or_replaced_during_service_stop(self):
        self.make_old()
        original = self.app.stat().st_ino
        replacement = self.root / "replacement"
        self.write(replacement / "marker", b"separate bundle")
        replacement_inode = replacement.stat().st_ino
        for change in ["moved", "replacement"]:
            self.environment["RELAY_FIXTURE_APP_AT_BOOTOUT"] = change
            self.assertIn("original App changed before staging", self.prepare(expected=1))
            self.assertEqual((self.root / "moved-original").stat().st_ino, original)
            self.assertFalse(self.transaction.exists())
            for service in ["system-proxy", "uninstall"]:
                self.assertTrue((self.root / ("job-local.relay.network." + service)).exists())
            if change == "moved":
                self.assertFalse(self.app.exists())
                (self.root / "moved-original").rename(self.app)
            else:
                self.assertEqual(self.app.stat().st_ino, replacement_inode)
                self.assertEqual((self.app / "marker").read_bytes(), b"separate bundle")

    def test_staged_app_must_match_the_preflight_directory(self):
        self.make_old()
        original = self.app.stat().st_ino
        self.write(self.root / "replacement/marker", b"separate bundle")
        self.environment["RELAY_FIXTURE_REPLACE_AT_RENAME"] = "yes"
        self.assertIn("staged App differs", self.prepare(expected=1))
        self.assertEqual((self.root / "moved-original").stat().st_ino, original)
        self.assertEqual((self.app / "marker").read_bytes(), b"separate bundle")
        self.assertFalse(self.transaction.exists())
        for service in ["system-proxy", "uninstall"]:
            self.assertTrue((self.root / ("job-local.relay.network." + service)).exists())
        self.assertTrue((self.relay / "Uninstall/installation.json").exists())
        self.assertTrue((self.relay / "SystemProxy/installation.json").exists())

    def test_upgrade_failure_restores_old_app_components_and_services(self):
        self.make_old()
        inode = self.app.stat().st_ino
        self.prepare()
        self.make_app()
        self.make_proxy()
        self.run_action("publish-tun")
        self.run_action("rollback-helper")
        self.run_action("rollback")
        self.assertEqual(self.app.stat().st_ino, inode)
        self.assertEqual((self.app / "Contents/MacOS/Relay").read_bytes(), b"old app")
        self.assertTrue((self.relay / "TunManaged/installation.json").exists())
        self.assertFalse(self.transaction.exists())
        self.assertTrue((self.root / "job-local.relay.network.uninstall").exists())
        self.assertTrue((self.root / "job-local.relay.network.system-proxy").exists())

    def test_partial_backup_failure_rolls_back_already_moved_paths(self):
        self.make_old()
        inode = self.app.stat().st_ino
        self.environment["RELAY_FIXTURE_MOVE_FAILURE"] = str(self.relay / "SystemProxy")
        self.prepare(expected=23)
        self.assertEqual(self.app.stat().st_ino, inode)
        self.assertTrue((self.relay / "Uninstall/installation.json").exists())
        self.assertFalse(self.transaction.exists())
        self.assertTrue((self.root / "job-local.relay.network.uninstall").exists())

    def test_partial_tun_copy_never_publishes_admission_and_rolls_back(self):
        self.make_old()
        self.prepare()
        self.make_app()
        self.environment["RELAY_FIXTURE_COPY_FAILURE"] = str(self.scripts / "RelayTunClient")
        self.run_action("publish-tun", expected=24)
        self.assertFalse((self.relay / "TunManaged").exists())
        self.environment.pop("RELAY_FIXTURE_COPY_FAILURE")
        self.run_action("rollback")
        self.assertEqual((self.app / "Contents/MacOS/Relay").read_bytes(), b"old app")
        self.assertFalse(self.transaction.exists())

    def test_committed_partial_backup_cleanup_never_rolls_back_new_app(self):
        self.make_old()
        self.prepare()
        self.make_app()
        self.make_proxy()
        self.run_action("publish-tun")
        self.make_monitor()
        self.environment["RELAY_FIXTURE_COMMIT_CLEANUP_FAILURE"] = "1"
        self.run_action("commit", expected=75)
        self.run_action("is-committed")
        for action in ["rollback", "rollback-monitor", "rollback-helper"]:
            self.assertIn("cannot roll back", self.run_action(action, expected=1))
        self.assertEqual((self.app / "Contents/MacOS/Relay").read_bytes(), b"new app")
        self.assertFalse((self.transaction / "old/app/Contents/MacOS/Relay").exists())
        self.assertTrue((self.relay / "SystemProxy/installation.json").exists())
        self.assertTrue((self.relay / "Uninstall/RelayUninstallSupervisor").exists())
        self.environment.pop("RELAY_FIXTURE_COMMIT_CLEANUP_FAILURE")
        self.prepare()  # Same verified package can finish cleanup and safely retry.
        self.assertEqual((self.transaction / "old/app/Contents/MacOS/Relay").read_bytes(), b"new app")
        self.run_action("rollback")
        self.assertEqual((self.app / "Contents/MacOS/Relay").read_bytes(), b"new app")

    def test_same_package_retry_recovers_prepared_transaction(self):
        self.make_old()
        inode = self.app.stat().st_ino
        self.prepare()
        self.make_app()
        self.make_proxy()
        self.run_action("publish-tun")
        self.make_monitor()
        self.run_action("record-monitor")
        self.prepare()
        self.assertEqual((self.transaction / "old/app").stat().st_ino, inode)
        self.assertFalse((self.relay / "Uninstall").exists())
        self.run_action("rollback")
        self.assertEqual(self.app.stat().st_ino, inode)

    def test_same_package_retry_preserves_incomplete_payload_and_restores_old_app(self):
        self.make_old()
        inode = self.app.stat().st_ino
        self.prepare()
        self.make_app()
        (self.app / "Contents/MacOS/Relay").unlink()
        self.write(self.app / "Contents/partial-download", b"do not delete this uncertain payload")
        self.prepare()
        self.assertEqual((self.transaction / "old/app").stat().st_ino, inode)
        retained = list((self.relay / "InstallerRecovery").glob("*/Relay.app/Contents/partial-download"))
        self.assertEqual(len(retained), 1)
        self.assertEqual(retained[0].read_bytes(), b"do not delete this uncertain payload")
        self.run_action("rollback")
        self.assertEqual(self.app.stat().st_ino, inode)
        self.assertTrue(retained[0].exists())

    def test_foreign_bundle_is_not_quarantined_or_deleted_on_retry(self):
        self.make_old()
        self.prepare()
        self.make_app()
        self.write(self.app / "Contents/Info.plist", plistlib.dumps({"CFBundleIdentifier": "org.other.application", "CFBundleExecutable": "Other"}))
        self.assertIn("foreign App retained", self.prepare(expected=1))
        self.assertTrue(self.app.exists())
        self.assertTrue((self.transaction / "old/app").exists())
        self.assertFalse((self.relay / "InstallerRecovery").exists())

    def test_app_restart_after_backup_prevents_payload_install(self):
        self.make_old()
        self.environment["RELAY_FIXTURE_START_AFTER_MOVE"] = "1"
        self.assertIn("仍在运行", self.prepare(expected=1))
        self.assertTrue((self.transaction / "old/app").exists())
        self.assertFalse(self.app.exists())
        self.assertNotIn("bootstrap", (self.root / "trace").read_text())

    def test_active_app_or_core_refused_before_any_mutation(self):
        self.make_old()
        for process in ["/Applications/Relay.app/Contents/MacOS/Relay", "/tmp/RelayCoreOwner", "/Library/Application Support/Relay/TunManaged/Core/darwin-arm64/mihomo",
                        "/Users/test/Library/Application Support/Relay-Preview/Variants/variants/core-fixture/darwin-arm64/mihomo"]:
            with self.subTest(process=process):
                self.environment["RELAY_FIXTURE_PROCESSES"] = process
                self.assertIn("仍在运行", self.prepare(expected=1))
                self.assertFalse(self.transaction.exists())
                self.assertFalse((self.root / "trace").exists())

    def test_busy_native_flock_blocks_upgrade_before_mutation(self):
        import fcntl
        self.make_old()
        with (self.relay / "TunManaged/busy.lock").open() as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertIn("lock is busy", self.prepare(expected=1))
        self.assertFalse(self.transaction.exists())
        self.assertFalse((self.root / "trace").exists())

    def assert_locked_identity_refusals(self, run):
        lock = self.relay / "TunManaged/busy.lock"
        held = self.root / "held-busy.lock"
        original = lock.stat()
        original_bytes = lock.read_bytes()

        def snapshot():
            result = {}
            for parent in [self.root / "Applications", self.root / "Library"]:
                for path in [parent, *parent.rglob("*")]:
                    if path == lock:
                        continue
                    info = path.lstat()
                    result[str(path.relative_to(self.root))] = (
                        info.st_ino, info.st_mode, path.read_bytes() if path.is_file() else None)
            trace = self.root / "trace"
            result["trace"] = trace.read_bytes() if trace.exists() else None
            result["jobs"] = sorted(path.name for path in self.root.glob("job-*"))
            return result

        before = snapshot()
        for fault in ["replace", "chmod", "stat-both"]:
            with self.subTest(fault=fault):
                variable = "RELAY_FIXTURE_STAT_IDENTITY_FAIL" if fault == "stat-both" else "RELAY_FIXTURE_LOCK_MUTATION"
                self.environment[variable] = "1" if fault == "stat-both" else fault
                try:
                    message = run()
                    if fault == "replace":
                        self.assertIn("lock replaced", message)
                        self.assertEqual(held.stat().st_ino, original.st_ino)
                        self.assertNotEqual(lock.stat().st_ino, original.st_ino)
                        self.assertEqual(lock.stat().st_mode & 0o7777, 0o644)
                    elif fault == "chmod":
                        self.assertRegex(message, r"file (mode|permissions)")
                        self.assertEqual(lock.stat().st_ino, original.st_ino)
                        self.assertEqual(lock.stat().st_mode & 0o7777, 0o600)
                    else:
                        self.assertIn("cannot inspect", message)
                    self.assertEqual(lock.read_bytes(), original_bytes)
                    self.assertEqual(snapshot(), before)
                finally:
                    self.environment.pop(variable, None)
                    if held.exists():
                        lock.unlink()
                        held.rename(lock)
                    lock.chmod(0o644)

    def test_upgrade_rejects_lock_changes_and_failed_identity_reads(self):
        self.make_old()
        self.assert_locked_identity_refusals(lambda: self.prepare(expected=1))
        self.assertFalse(self.transaction.exists())

    def test_rollback_rejects_lock_changes_and_failed_identity_reads(self):
        self.make_old()
        self.prepare()
        self.make_app()
        self.run_action("publish-tun")
        self.assert_locked_identity_refusals(lambda: self.run_action("rollback", expected=1))
        self.assertTrue((self.transaction / "old/app").exists())
        self.assertTrue((self.relay / "TunManaged/installation.json").exists())

    def test_shell_remover_rejects_lock_changes_and_failed_identity_reads(self):
        self.make_old()
        remover, reviewed = self.stage_shell_remover()

        def run():
            result = subprocess.run([remover, "--remove", reviewed], env=self.environment, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            return result.stdout + result.stderr

        self.assert_locked_identity_refusals(run)
        self.assertTrue((self.relay / "TunManaged/installation.json").exists())

    def test_wrong_user_damaged_hash_symlink_and_unknown_content_refused(self):
        self.make_old()
        for change, undo in [
            (lambda: self.environment.update(RELAY_FIXTURE_UID="502"), lambda: self.environment.pop("RELAY_FIXTURE_UID")),
            (lambda: self.write(self.relay / "TunManaged/RelayTunClient", b"changed", 0o755), lambda: self.write(self.relay / "TunManaged/RelayTunClient", b"new client", 0o755)),
            (lambda: (self.relay / "TunManaged/foreign").symlink_to(self.root / "missing"), lambda: (self.relay / "TunManaged/foreign").unlink()),
            (lambda: self.write(self.relay / "Uninstall/intent.json", b"{}"), lambda: (self.relay / "Uninstall/intent.json").unlink()),
        ]:
            change()
            self.prepare(expected=1)
            self.assertFalse(self.transaction.exists())
            self.assertFalse((self.root / "trace").exists())
            undo()

    def test_missing_console_and_orphan_receipt_refuse_before_mutation(self):
        self.environment["RELAY_FIXTURE_UID"] = "0"
        self.assertIn("ordinary logged-in", self.prepare(expected=1))
        self.environment["RELAY_FIXTURE_UID"] = "501"
        self.environment["RELAY_FIXTURE_RECEIPTS"] = "local.relay.network.app"
        self.assertIn("no trusted installation", self.prepare(expected=1))
        self.assertFalse(self.transaction.exists())

    def test_console_change_during_install_or_changed_plan_refuses(self):
        self.prepare()
        self.environment["RELAY_FIXTURE_UID"] = "502"
        self.assertIn("console user changed", self.run_action("verify", expected=1))
        self.environment["RELAY_FIXTURE_UID"] = "501"
        self.write(self.scripts / "install-plan.json", b"{}")
        self.assertIn("changed file", self.run_action("verify", expected=1))
        self.assertTrue(self.transaction.exists())

    def test_accepted_removal_retires_old_backup_but_preserves_cleanup_owner(self):
        self.make_old()
        self.prepare()
        self.make_app()
        self.make_monitor()
        self.run_action("record-monitor")
        self.json(self.relay / "Uninstall/intent.json", {"generation": "other-generation", "clientUID": 501})
        self.run_action("retire-backup-for-removal", expected=1)
        self.assertTrue(self.transaction.exists())
        self.json(self.relay / "Uninstall/intent.json", {"generation": "fixture-generation", "clientUID": 501})
        self.run_action("retire-backup-for-removal")
        self.assertFalse(self.transaction.exists())
        self.assertTrue((self.relay / "Uninstall/intent.json").exists())
        self.assertTrue((self.relay / "Uninstall/RelayUninstallSupervisor").exists())

    def test_upgrade_without_previous_tun_and_accepted_removal_guard(self):
        self.make_old(tun=False)
        self.prepare()
        self.make_app()
        self.run_action("publish-tun")
        self.write(self.relay / "Uninstall/intent.json", b"{}")
        self.assertIn("installation.json", self.run_action("rollback", expected=1))
        self.assertTrue((self.transaction / "old/app").exists())
        self.assertTrue((self.relay / "Uninstall/intent.json").exists())


if __name__ == "__main__":
    unittest.main()
