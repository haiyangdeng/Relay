#!/usr/bin/env python3
"""Run the shipped uninstaller against a disposable filesystem and stubbed system tools."""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import unittest


APP = Path(__file__).resolve().parents[2]
SCRIPT = APP / 'native/installer/package/Uninstall-Relay.command'


class UninstallTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='relay-uninstall-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.app = self.root / 'Applications/Relay.app'
        self.home = self.root / 'home'
        self.state = self.home / 'Library/Application Support/Relay-Preview'
        self.proxy = self.root / 'Library/Application Support/Relay/SystemProxy'
        self.tun = self.proxy.with_name('TunManaged')
        self.session = self.state / 'Core/.session'
        self.archived_session = self.state / 'Core/AbandonedSessions/fixture'
        self.trace = self.root / 'trace'
        self.env = {**os.environ, 'HOME': str(self.home), 'RELAY_FIXTURE': str(self.root)}
        self.script = self.root / 'uninstall.command'
        (self.root / 'Applications').mkdir()
        (self.home / '.Trash').mkdir(parents=True)
        tools = {
            '/usr/bin/id': 'echo 501',
            '/usr/bin/dscacheutil': 'printf "dir: %s\\n" "$HOME"',
            '/usr/bin/stat': '''
case "$2:$3" in
  %u:%Lp:%l:*/installation.json) echo 0:644:1;;
  %u:%Lp:%l:*/installation.pending.json) echo 0:600:1;;
  %u:%Lp:%l:*) echo 0:755:1;;
  %u:*/.Trash) echo 501;;
  %u:*) echo 0;;
  *) exec /usr/bin/stat "$@";;
esac
''',
            '/usr/bin/codesign': 'exit 0',
            '/usr/bin/xcode-select': '[ "${RELAY_NO_CLT:-}" != yes ]',
            '/usr/sbin/pkgutil': '''
if [ "$1" = --forget ]; then
    [ "${RELAY_KEEP_RECEIPT:-}" != yes ] || exit 0
    /usr/bin/touch "$RELAY_FIXTURE/forgot-$2"
    exit 0
fi
printf '%s\\n' "${RELAY_RECEIPTS:-}" | while IFS= read -r receipt; do
    [ -f "$RELAY_FIXTURE/forgot-$receipt" ] || printf '%s\\n' "$receipt"
done
''',
            '/bin/launchctl': '[ -z "${RELAY_JOB_ERROR:-}" ] || exit "$RELAY_JOB_ERROR"; test "$2" = "${RELAY_JOB:-}" || exit 113',
            '/bin/ps': 'printf "%s\\n" "${RELAY_PROCESSES:-}"',
            '/usr/bin/sudo': '''
printf '%s\\n' "$1" >> "$RELAY_FIXTURE/trace"
case "$1" in
  -v) exit 0;;
  /usr/sbin/pkgutil|*/mock-pkgutil) exec "$@";;
  */TunManaged/uninstall.py|*/SystemProxy/uninstall) exec "$@";;
  *) exit 97;;
esac
''',
        }
        source = SCRIPT.read_text()
        for name, script in tools.items():
            tool = self.root / ('mock-' + Path(name).name)
            self.executable(tool, '#!/bin/sh\n' + script)
            source = source.replace(name, shlex.quote(str(tool)))
        source = re.sub(r"(?<=[='\s])/(Applications|Library)(?=[/'\s])",
                        lambda match: str(self.root) + match[0], source)
        inspector = self.root / 'Relay-Uninstall-Inspector'
        self.executable(inspector, '''#!/bin/sh
request=$(/bin/cat)
case "$1:$request" in
  --system-proxy:*'"action":"inspect"'*)
    if [ -f "$RELAY_FIXTURE/proxy-inspected" ] && [ -n "${RELAY_PROXY_CHANGED_REPORT:-}" ]; then
      printf "%s\\n" "$RELAY_PROXY_CHANGED_REPORT"
    else
      /usr/bin/touch "$RELAY_FIXTURE/proxy-inspected"
      printf "%s\\n" "$RELAY_PROXY_REPORT"
    fi;;
  --system-proxy:*'"action":"restore"'*)
    echo restore >> "$RELAY_FIXTURE/trace"
    [ "${RELAY_PROXY_REFUSE_RESTORE:-}" != yes ] || exit 1
    if [ "${RELAY_PROXY_UNCERTAIN:-}" = yes ]; then echo '{"status":"uncertain"}'; exit 0; fi
    /bin/mv "$HOME/Library/Application Support/Relay-Preview/SystemProxy/active.json" "$RELAY_FIXTURE/restored.json"
    echo '{"status":"restored"}';;
  --system-proxy:*'"action":"retireDetached"'*)
    /bin/mv "$HOME/Library/Application Support/Relay-Preview/SystemProxy/active.json" "$RELAY_FIXTURE/retired.json"
    printf '%s\\n' '{"status":"inactive"}';;
  --core-record-recovery:*'"action":"inspect"'*)
    if [ -f "$RELAY_FIXTURE/core-inspected" ] && [ -n "${RELAY_CORE_CHANGED_REPORT:-}" ]; then
      printf "%s\\n" "$RELAY_CORE_CHANGED_REPORT"
    else
      /usr/bin/touch "$RELAY_FIXTURE/core-inspected"
      printf "%s\\n" "$RELAY_CORE_REPORT"
    fi;;
  --core-record-recovery:*'"action":"archive"'*'"expectedRevision":"'"$RELAY_CORE_REVISION"'"'*)
    [ "${RELAY_CORE_REFUSE_ARCHIVE:-}" != yes ] || exit 1
    core="$HOME/Library/Application Support/Relay-Preview/Core"
    /bin/mkdir "$core/AbandonedSessions" || exit 1
    /bin/mv "$core/.session" "$core/AbandonedSessions/fixture" || exit 1
    printf '{"status":"archived","revision":"%s"}\\n' "$RELAY_CORE_REVISION";;
  *) exit 1;;
esac
''')
        self.executable(self.script, source.replace('@INSPECTOR_SHA256@', self.digest(inspector)))

    def executable(self, path, text):
        path.write_text(text)
        path.chmod(0o755)

    def digest(self, path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def app_bundle(self):
        (self.app / 'Contents').mkdir(parents=True)
        (self.app / 'Contents/Info.plist').write_text(json.dumps({'CFBundleIdentifier': 'local.relay.network.preview'}))

    def component(self, directory, name, role, busy=False):
        directory.mkdir(parents=True)
        script = directory / name
        remove = 'exit 1' if busy else f'/bin/rm -r {shlex.quote(str(directory))}'
        self.executable(script, '#!/bin/sh\n' + remove + '\n')
        (directory / 'installation.json').write_text(json.dumps({
            'version': 1, 'role': role, 'clientUID': 501, 'uninstallerSHA256': self.digest(script)
        }))

    def core_record(self, status='stale', can_archive=True, revision='c' * 64):
        self.session.mkdir(parents=True)
        (self.session / 'owner.json').write_text('fixture owner')
        self.env['RELAY_CORE_REVISION'] = revision
        self.env['RELAY_CORE_REPORT'] = json.dumps({
            'status': status, 'canArchive': can_archive, 'revision': revision
        })

    def run_uninstall(self, *args, accepted=False, expected=0):
        result = subprocess.run([str(self.script), *args], env=self.env,
                                input='UNINSTALL\n' if accepted else '', text=True, capture_output=True)
        output = result.stdout + result.stderr
        self.assertEqual(result.returncode, expected, output)
        return output

    def active_proxy_record(self, revision='a' * 64):
        pointer = self.state / 'SystemProxy/active.json'
        pointer.parent.mkdir(parents=True, exist_ok=True)
        pointer.touch()
        self.env['RELAY_PROXY_REPORT'] = json.dumps({'status': 'active', 'canRestore': True,
                                                   'canRetireDetached': False, 'recordID': 'fixture',
                                                   'revision': revision})
        return pointer

    def automatic_monitor(self):
        monitor = self.proxy.with_name('Uninstall')
        monitor.mkdir(parents=True)
        supervisor = monitor / 'RelayUninstallSupervisor'
        self.executable(supervisor, '#!/bin/sh\nexit 99\n')
        (monitor / 'installation.json').write_text(json.dumps({
            'version': 1, 'clientUID': 501, 'supervisorSHA256': self.digest(supervisor)}))
        self.env['RELAY_JOB'] = 'system/local.relay.network.uninstall'
        return monitor

    def test_automatic_installation_directs_to_trash_without_parallel_cleanup(self):
        monitor = self.automatic_monitor()
        self.app_bundle()
        self.active_proxy_record()
        self.env['RELAY_PROCESSES'] = '/Applications/Relay.app/Contents/MacOS/Relay'
        self.assertIn('拖到废纸篓即可', self.run_uninstall(accepted=True))
        self.assertTrue(self.app.exists() and monitor.exists())
        self.assertFalse(self.trace.exists())

    def test_automatic_uninstall_in_progress_does_not_run_legacy_removers(self):
        monitor = self.automatic_monitor()
        (monitor / 'intent.json').write_text('{}')
        self.component(self.proxy, 'uninstall', 'system-proxy-v1')
        self.assertIn('自动卸载已开始', self.run_uninstall(accepted=True))
        self.assertTrue(self.proxy.exists() and monitor.exists())
        self.assertFalse(self.trace.exists())

    def test_missing_monitor_root_with_automatic_daemon_refuses_legacy_cleanup(self):
        daemon = self.root / 'Library/LaunchDaemons/local.relay.network.uninstall.plist'
        daemon.parent.mkdir(parents=True)
        daemon.write_text('retained daemon')
        self.component(self.proxy, 'uninstall', 'system-proxy-v1')
        self.env['RELAY_RECEIPTS'] = 'local.relay.network.app'
        self.assertIn('自动卸载监控安装不完整', self.run_uninstall(accepted=True, expected=1))
        self.assertTrue(daemon.exists() and self.proxy.exists())
        self.assertFalse(self.trace.exists())
        self.assertFalse((self.root / 'forgot-local.relay.network.app').exists())

    def test_missing_monitor_root_with_loaded_automatic_job_refuses_legacy_cleanup(self):
        self.env['RELAY_JOB'] = 'system/local.relay.network.uninstall'
        self.env['RELAY_RECEIPTS'] = 'local.relay.network.app'
        self.assertIn('自动卸载监控安装不完整', self.run_uninstall(accepted=True, expected=1))
        self.assertFalse(self.trace.exists())
        self.assertFalse((self.root / 'forgot-local.relay.network.app').exists())

    def test_check_and_cancellation_never_restore_proxy(self):
        pointer = self.active_proxy_record()
        self.run_uninstall('--check')
        self.run_uninstall(expected=1)
        self.assertTrue(pointer.exists())
        self.assertFalse(self.trace.exists())

    def test_removed_app_restores_proxy_before_removing_components(self):
        self.component(self.proxy, 'uninstall', 'system-proxy-v1')
        self.component(self.tun, 'uninstall.py', 'core-managed-v2')
        pointer = self.active_proxy_record()
        self.assertIn('已恢复 Relay 记录的原系统代理设置', self.run_uninstall(accepted=True))
        self.assertFalse(pointer.exists() or self.proxy.exists() or self.tun.exists())
        self.assertTrue((self.root / 'restored.json').exists())
        self.assertEqual(self.trace.read_text().splitlines(),
                         ['-v', 'restore', str(self.tun / 'uninstall.py'), str(self.proxy / 'uninstall')])

    def test_restore_failure_preserves_every_component_and_app(self):
        self.app_bundle()
        self.component(self.proxy, 'uninstall', 'system-proxy-v1')
        self.component(self.tun, 'uninstall.py', 'core-managed-v2')
        pointer = self.active_proxy_record()
        for variable in ('RELAY_PROXY_REFUSE_RESTORE', 'RELAY_PROXY_UNCERTAIN'):
            with self.subTest(variable=variable):
                self.env[variable] = 'yes'
                self.run_uninstall(accepted=True, expected=1)
                self.assertTrue(pointer.exists() and self.app.exists() and self.tun.exists() and self.proxy.exists())
                self.assertEqual(self.trace.read_text().splitlines(), ['-v', 'restore'])
                self.trace.unlink()
                del self.env[variable]

    def test_proxy_revision_change_blocks_removals_after_confirmation(self):
        self.component(self.proxy, 'uninstall', 'system-proxy-v1')
        pointer = self.active_proxy_record()
        self.env['RELAY_PROXY_CHANGED_REPORT'] = self.env['RELAY_PROXY_REPORT'].replace('a' * 64, 'b' * 64)
        self.assertIn('系统代理或恢复记录在确认后变化', self.run_uninstall(accepted=True, expected=1))
        self.assertTrue(pointer.exists() and self.proxy.exists())
        self.assertEqual(self.trace.read_text().splitlines(), ['-v'])

    def test_interrupted_proxy_uninstall_uses_pinned_recovery_plan(self):
        self.component(self.proxy, 'uninstall', 'system-proxy-v1')
        (self.proxy / 'installation.json').rename(self.proxy / 'installation.pending.json')
        self.run_uninstall(accepted=True)
        self.assertFalse(self.proxy.exists())
        self.assertEqual(self.trace.read_text().splitlines(), ['-v', str(self.proxy / 'uninstall')])

    def test_launchctl_permission_error_never_looks_like_absent_service(self):
        self.env['RELAY_JOB_ERROR'] = '1'
        self.assertIn('无法确认系统服务注册状态', self.run_uninstall(accepted=True, expected=1))
        self.assertFalse(self.trace.exists())

    def test_receipt_only_residue_can_be_removed_without_payload(self):
        self.env['RELAY_RECEIPTS'] = '\n'.join(['local.relay.network.system-proxy.v1',
                                               'local.relay.network.tun.core-managed-v2',
                                               'unrelated.application'])
        self.run_uninstall(accepted=True)
        self.assertTrue((self.root / 'forgot-local.relay.network.system-proxy.v1').is_file())
        self.assertTrue((self.root / 'forgot-local.relay.network.tun.core-managed-v2').is_file())
        self.assertFalse((self.root / 'forgot-unrelated.application').exists())

    def test_unremoved_receipt_prevents_app_removal(self):
        self.app_bundle()
        self.env['RELAY_RECEIPTS'] = 'local.relay.network.app'
        self.env['RELAY_KEEP_RECEIPT'] = 'yes'
        self.assertIn('安装记录仍有残留', self.run_uninstall(accepted=True, expected=1))
        self.assertTrue(self.app.exists())

    def test_running_moved_copy_does_not_request_authorization(self):
        self.app_bundle()
        self.env['RELAY_PROCESSES'] = '/gone/Relay.app/Contents/MacOS/Relay'
        self.assertIn('仍在运行', self.run_uninstall(accepted=True, expected=1))
        self.assertFalse(self.trace.exists())
        self.assertTrue(self.app.is_dir())

    def test_removes_only_known_components_then_moves_app(self):
        self.app_bundle()
        self.component(self.proxy, 'uninstall', 'system-proxy-v1')
        self.component(self.tun, 'uninstall.py', 'core-managed-v2')
        self.state.mkdir(parents=True)
        self.env['RELAY_PROCESSES'] = '/Applications/Clash Party.app/Contents/Resources/sidecar/mihomo'
        self.run_uninstall(accepted=True)
        self.assertFalse(self.app.exists())
        self.assertTrue(self.state.is_dir())
        self.assertFalse(self.proxy.exists() or self.tun.exists())
        self.assertEqual(len(list((self.home / '.Trash').glob('*/Relay.app'))), 1)
        self.assertEqual(self.trace.read_text().splitlines(), ['-v', str(self.tun / 'uninstall.py'), str(self.proxy / 'uninstall')])

    def test_already_removed_app_can_clean_detached_proxy_record(self):
        self.component(self.proxy, 'uninstall', 'system-proxy-v1')
        pointer = self.state / 'SystemProxy/active.json'
        pointer.parent.mkdir(parents=True)
        pointer.touch()
        self.env['RELAY_PROXY_REPORT'] = json.dumps({'status': 'conflict', 'canRestore': False,
                                                   'canRetireDetached': True, 'recordID': 'fixture',
                                                   'quitProxyPorts': [], 'revision': 'a' * 64})
        self.run_uninstall(accepted=True)
        self.assertFalse(self.proxy.exists())
        self.assertFalse(pointer.exists())
        self.assertTrue((self.root / 'retired.json').is_file())

    def test_unconfirmed_proxy_record_blocks_removal(self):
        self.component(self.proxy, 'uninstall', 'system-proxy-v1')
        pointer = self.state / 'SystemProxy/active.json'
        pointer.parent.mkdir(parents=True)
        pointer.touch()
        self.env['RELAY_PROXY_REPORT'] = '{"status":"conflict","canRestore":false,"canRetireDetached":false,"recordID":"fixture"}'
        self.assertIn('恢复记录仍待处理', self.run_uninstall(accepted=True, expected=1))
        self.assertTrue(self.proxy.is_dir())
        self.assertFalse(self.trace.exists())

    def test_only_detached_record_is_retired_without_requesting_sudo(self):
        pointer = self.state / 'SystemProxy/active.json'
        pointer.parent.mkdir(parents=True)
        pointer.touch()
        self.env['RELAY_PROXY_REPORT'] = json.dumps({'status': 'conflict', 'canRestore': False,
                                                   'canRetireDetached': True, 'recordID': 'fixture',
                                                   'revision': 'b' * 64})
        self.run_uninstall(accepted=True)
        self.assertFalse(pointer.exists())
        self.assertTrue((self.root / 'retired.json').is_file())
        self.assertFalse(self.trace.exists())

    def test_explicit_retirement_evidence_accepts_noop_or_restored_original(self):
        for status in ('active', 'pending'):
            with self.subTest(status=status):
                pointer = self.state / 'SystemProxy/active.json'
                pointer.parent.mkdir(parents=True, exist_ok=True)
                pointer.touch()
                self.env['RELAY_PROXY_REPORT'] = json.dumps({'status': status, 'canRestore': True,
                                                           'canRetireDetached': True, 'recordID': 'fixture',
                                                           'revision': 'c' * 64})
                self.run_uninstall(accepted=True)
                self.assertFalse(pointer.exists())
                self.assertFalse(self.trace.exists())

    def test_check_preserves_verified_stale_record(self):
        self.core_record()
        self.run_uninstall('--check')
        self.assertTrue(self.session.is_dir())
        self.assertFalse(self.archived_session.exists() or self.trace.exists())

    def test_only_stale_core_record_is_archived_without_sudo(self):
        self.core_record()
        self.assertIn('已归档停止的旧核心会话记录', self.run_uninstall(accepted=True))
        self.assertFalse(self.session.exists() or self.trace.exists())
        self.assertEqual((self.archived_session / 'owner.json').read_text(), 'fixture owner')

    def test_live_or_unknown_core_record_blocks_uninstall(self):
        self.app_bundle()
        self.core_record(status='liveOrUnknown', can_archive=False)
        self.assertIn('核心会话记录仍在使用或无法确认', self.run_uninstall(accepted=True, expected=1))
        self.assertTrue(self.app.is_dir() and self.session.is_dir())
        self.assertFalse(self.archived_session.exists() or self.trace.exists())

    def test_changed_core_revision_leaves_app_and_components(self):
        self.app_bundle()
        self.component(self.tun, 'uninstall.py', 'core-managed-v2')
        self.core_record()
        self.env['RELAY_CORE_CHANGED_REPORT'] = json.dumps({
            'status': 'stale', 'canArchive': True, 'revision': 'd' * 64
        })
        self.assertIn('核心会话记录在确认后变化', self.run_uninstall(accepted=True, expected=1))
        self.assertTrue(self.app.is_dir() and self.tun.is_dir() and self.session.is_dir())
        self.assertFalse(self.archived_session.exists())
        self.assertEqual(self.trace.read_text().splitlines(), ['-v'])

    def test_archive_refusal_leaves_app_and_record(self):
        self.app_bundle()
        self.core_record()
        self.env['RELAY_CORE_REFUSE_ARCHIVE'] = 'yes'
        self.assertIn('旧核心会话记录或进程状态已变化', self.run_uninstall(accepted=True, expected=1))
        self.assertTrue(self.app.is_dir() and self.session.is_dir())
        self.assertFalse(self.archived_session.exists() or self.trace.exists())

    def test_shell_tun_remover_needs_no_command_line_tools(self):
        self.component(self.tun, 'uninstall.py', 'core-managed-v2')
        self.env['RELAY_NO_CLT'] = 'yes'
        self.run_uninstall(accepted=True)
        self.assertFalse(self.tun.exists())

    def test_private_variant_core_prevents_uninstall_without_stopping_it(self):
        self.app_bundle()
        self.env['RELAY_PROCESSES'] = str(self.state / 'Variants/variants/core-fixture/darwin-arm64/mihomo')
        self.run_uninstall('--check', expected=1)
        self.assertTrue(self.app.exists())
        self.assertFalse(self.trace.exists())

    def test_busy_tun_keeps_app_and_proxy(self):
        self.app_bundle()
        self.component(self.proxy, 'uninstall', 'system-proxy-v1')
        self.component(self.tun, 'uninstall.py', 'core-managed-v2', busy=True)
        self.assertIn('TUN 组件卸载失败', self.run_uninstall(accepted=True, expected=1))
        self.assertTrue(self.app.is_dir() and self.proxy.is_dir() and self.tun.is_dir())

    def test_orphan_legacy_service_is_reported_without_authorization(self):
        self.env['RELAY_JOB'] = 'system/local.relay.network.tun'
        self.assertIn('旧版 Relay TUN', self.run_uninstall('--check', expected=1))
        self.assertFalse(self.trace.exists())


if __name__ == '__main__':
    unittest.main()
