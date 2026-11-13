#!/bin/sh
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

app=/Applications/Relay.app
relay='/Library/Application Support/Relay'
proxy="$relay/SystemProxy"
tun="$relay/TunManaged"
helper=/Library/PrivilegedHelperTools/local.relay.network.system-proxy
daemon=/Library/LaunchDaemons/local.relay.network.system-proxy.plist
bundle_id=local.relay.network.preview
app_receipt=local.relay.network.app
proxy_receipt=local.relay.network.system-proxy.v1

fail() { echo "Relay 卸载暂停：$*" >&2; exit 1; }
present() { [ -e "$1" ] || [ -L "$1" ]; }
digest() { /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'; }
value() { /usr/bin/plutil -extract "$2" raw -o - "$1"; }
receipt_exists() { printf '%s\n' "$receipts" | /usr/bin/grep -Fqx "$1"; }
known_receipt_present() {
    for candidate in "$app_receipt" "$proxy_receipt" local.relay.network.tun.core-managed-v1 local.relay.network.tun.core-managed-v2; do
        if receipt_exists "$candidate"; then return 0; fi
    done
    return 1
}
root_directory() {
    [ -d "$1" ] && [ ! -L "$1" ] || fail "组件路径异常：$1"
    [ "$(/usr/bin/stat -f '%u' "$1")" = 0 ] || fail "组件路径不是管理员所有：$1"
    mode=$(/usr/bin/stat -f '%Lp' "$1")
    [ "$((0$mode & 06022))" = 0 ] || fail "组件路径权限异常：$1"
}
root_file() {
    [ -f "$1" ] && [ ! -L "$1" ] && [ "$(/usr/bin/stat -f '%u:%Lp:%l' "$1")" = "0:$2:1" ] ||
        fail "组件文件身份异常：$1"
}
job_exists() {
    if /bin/launchctl print "system/$1" >/dev/null 2>&1; then
        return 0
    else
        result=$?
        [ "$result" = 113 ] || fail '无法确认系统服务注册状态。'
        return 1
    fi
}
require_inspector() {
    script_dir=$(CDPATH= cd -P "$(/usr/bin/dirname "$0")" && /bin/pwd -P)
    native="$script_dir/Relay-Uninstall-Inspector"
    [ -f "$native" ] && [ -x "$native" ] && [ ! -L "$native" ] &&
        [ "$(digest "$native")" = '@INSPECTOR_SHA256@' ] &&
        /usr/bin/codesign --verify --strict "$native" || fail '仍有恢复记录，请使用完整交付目录中的卸载工具。'
    case "$user_home" in *[!a-zA-Z0-9_./\ -]*) fail '当前主目录无法安全传给恢复记录检查。';; esac
}
require_idle() {
    active_revision=
    proxy_action=
    core_revision=
    processes=$(/bin/ps -axo comm=) || fail '无法检查运行进程。'
    if printf '%s\n' "$processes" | /usr/bin/grep -Eq '\.app/Contents/(MacOS/Relay$|Frameworks/Relay Helper|Resources/relay/.*/mihomo$)|/Relay/(TunManaged|Tun)/|/Relay-Preview/(Core|CoreOwner|NativeRuntime)/|/Relay(CoreOwner|TunClient|TunHelper|Browser)$'; then
        fail 'Relay 或其后台核心仍在运行。请通过 Relay 菜单退出后再卸载。'
    fi
    for record in "$user_state/CoreOwner/.session" "$user_state/Desktop Login/state.json"; do
        if present "$record"; then fail "Relay 仍有待处理的运行记录：$record"; fi
    done
    if present "$core_record"; then
        require_inspector
        report=$(printf '{"action":"inspect","context":{"home":"%s","stateRoot":"%s"}}' "$user_home" "$user_state" | "$native" --core-record-recovery) ||
            fail '无法确认核心会话记录。'
        [ "$(printf '%s' "$report" | /usr/bin/plutil -extract status raw -expect string -o - -)" = stale ] &&
            [ "$(printf '%s' "$report" | /usr/bin/plutil -extract canArchive raw -expect bool -o - -)" = true ] ||
            fail 'Relay 的核心会话记录仍在使用或无法确认。'
        core_revision=$(printf '%s' "$report" | /usr/bin/plutil -extract revision raw -expect string -o - -) || fail '无法核对核心会话记录版本。'
        printf '%s\n' "$core_revision" | /usr/bin/grep -Eq '^[a-f0-9]{64}$' || fail '核心会话记录版本无效。'
    fi
    if present "$user_state/SystemProxy/active.json"; then
        require_inspector
        report=$(printf '{"action":"inspect","context":{"home":"%s","stateRoot":"%s"}}' "$user_home" "$user_state" | "$native" --system-proxy) ||
            fail '无法确认系统代理恢复记录。'
        can_retire=$(printf '%s' "$report" | /usr/bin/plutil -extract canRetireDetached raw -expect bool -o - -) || fail '无法读取恢复记录归档条件。'
        can_restore=$(printf '%s' "$report" | /usr/bin/plutil -extract canRestore raw -expect bool -o - -) || fail '无法读取代理恢复条件。'
        if [ "$can_retire" = true ]; then proxy_action=retireDetached
        elif [ "$can_restore" = true ]; then proxy_action=restore
        else fail 'Relay 的系统代理恢复记录仍待处理；当前代理存在外部修改，未覆盖。'; fi
        printf '%s' "$report" | /usr/bin/plutil -extract recordID raw -expect string -o - - >/dev/null ||
            fail 'Relay 的系统代理恢复记录身份缺失。'
        active_revision=$(printf '%s' "$report" | /usr/bin/plutil -extract revision raw -expect string -o - -) ||
            fail '无法核对恢复记录版本。'
        printf '%s\n' "$active_revision" | /usr/bin/grep -Eq '^[a-f0-9]{64}$' || fail '恢复记录版本无效。'
    fi
}
inspect() {
    app_present=no; proxy_present=no; tun_present=no
    receipts=$(/usr/sbin/pkgutil --pkgs) || fail '无法读取安装记录。'
    if present "$app"; then
        [ -d "$app" ] && [ ! -L "$app" ] && [ -f "$app/Contents/Info.plist" ] && [ ! -L "$app/Contents/Info.plist" ] ||
            fail '应用程序路径异常。'
        [ "$(value "$app/Contents/Info.plist" CFBundleIdentifier)" = "$bundle_id" ] || fail '应用程序身份与 Relay 不符。'
        /usr/bin/codesign --verify --deep --strict "$app" || fail '应用程序签名校验失败。'
        app_identity=$(/usr/bin/stat -f '%d:%i' "$app")
        app_present=yes
    fi
    if present "$relay"; then
        for directory in /Library '/Library/Application Support' "$relay"; do root_directory "$directory"; done
    fi
    if present "$proxy" || present "$helper" || present "$daemon" || job_exists local.relay.network.system-proxy; then
        root_directory "$proxy"
        # The pinned installed uninstaller already supports interrupted install
        # and uninstall recovery. Keep that path reachable from the full tool.
        if present "$proxy/installation.pending.json"; then
            manifest="$proxy/installation.pending.json"; manifest_mode=600
        else manifest="$proxy/installation.json"; manifest_mode=644; fi
        root_file "$manifest" "$manifest_mode"
        [ "$(value "$manifest" version)" = 1 ] || fail '系统代理组件版本未知。'
        [ "$(value "$manifest" role)" = system-proxy-v1 ] || fail '系统代理组件类型未知。'
        [ "$(value "$manifest" clientUID)" = "$user_uid" ] || fail '系统代理组件属于其他用户。'
        root_file "$proxy/uninstall" 755
        [ "$(digest "$proxy/uninstall")" = "$(value "$manifest" uninstallerSHA256)" ] || fail '系统代理卸载器摘要不匹配。'
        proxy_present=yes
    fi
    for legacy in "$relay/Tun" /Library/LaunchDaemons/local.relay.network.tun.plist \
        /Library/PrivilegedHelperTools/local.relay.network.tun \
        /Library/PrivilegedHelperTools/local.relay.network.tun.uninstall \
        /Library/PrivilegedHelperTools/local.relay.network.tun.uninstall-intent.json \
        /Library/PrivilegedHelperTools/local.relay.network.tun.operation-lock \
        /Library/PrivilegedHelperTools/local.relay.network.tun.uninstall-active \
        /Library/PrivilegedHelperTools/.local.relay.network.tun.network-executor-v1-publish-*; do
        if present "$legacy"; then fail '发现旧版 Relay TUN 组件，请先用其原配卸载器处理。'; fi
    done
    if receipt_exists local.relay.network.tun.network-executor-v1 || receipt_exists local.relay.network.tun.feasibility || job_exists local.relay.network.tun; then
        fail '发现旧版 Relay TUN 安装记录或服务，请先用其原配卸载器处理。'
    fi
    if present "$tun"; then
        /usr/bin/xcode-select -p >/dev/null 2>&1 || fail '现有 TUN 卸载工具需要可用的 macOS Command Line Tools。'
        root_directory "$tun"
        root_file "$tun/installation.json" 644
        case "$(value "$tun/installation.json" role)" in core-managed-v1|core-managed-v2) ;; *) fail 'TUN 组件类型未知。';; esac
        [ "$(value "$tun/installation.json" clientUID)" = "$user_uid" ] || fail 'TUN 组件属于其他用户。'
        root_file "$tun/uninstall.py" 755
        [ "$(digest "$tun/uninstall.py")" = "$(value "$tun/installation.json" uninstallerSHA256)" ] || fail 'TUN 卸载器摘要不匹配。'
        tun_digest=$(digest "$tun/installation.json")
        tun_present=yes
    fi
    echo "应用程序 ${app_present}，系统代理组件 ${proxy_present}，TUN 组件 ${tun_present}。"
    require_idle
}

user_uid=$(/usr/bin/id -u)
[ "$user_uid" != 0 ] || fail '请以当前桌面用户打开，卸载时会单独请求管理员授权。'
user_home=$(/usr/bin/dscacheutil -q user -a uid "$user_uid" | /usr/bin/sed -n 's/^dir: //p')
[ "$user_home" = "$HOME" ] && [ -d "$user_home" ] || fail '无法确认当前用户主目录。'
user_state="$user_home/Library/Application Support/Relay-Preview"
core_record="$user_state/Core/.session"
case "${1:-}" in ''|--check) [ "$#" -le 1 ] || fail '仅支持 --check。';; *) fail '仅支持 --check。';; esac
# New installations have one automatic owner for the entire uninstall chain.
# Never race its root cleanup with the legacy interactive uninstaller below.
monitor="$relay/Uninstall"
if present "$monitor"; then
    for directory in /Library '/Library/Application Support' "$relay" "$monitor"; do root_directory "$directory"; done
    root_file "$monitor/installation.json" 644
    [ "$(value "$monitor/installation.json" version)" = 1 ] || fail '自动卸载组件版本未知。'
    [ "$(value "$monitor/installation.json" clientUID)" = "$user_uid" ] || fail '自动卸载组件属于其他用户。'
    root_file "$monitor/RelayUninstallSupervisor" 755
    [ "$(digest "$monitor/RelayUninstallSupervisor")" = "$(value "$monitor/installation.json" supervisorSHA256)" ] ||
        fail '自动卸载组件摘要不匹配。'
    job_exists local.relay.network.uninstall || fail '自动卸载监控未运行，已保留恢复记录和组件。'
    if present "$app"; then
        echo '此版本支持自动卸载：把 /Applications/Relay.app 拖到废纸篓即可，后台将自动恢复设置并移除 Relay 组件和数据。'
    elif present "$monitor/intent.json"; then
        echo 'Relay 自动卸载已开始，后台正在完成清理。无需再次运行卸载工具。'
    else
        echo '自动卸载监控正在跟踪 Relay 的实际位置；把该 Relay.app 拖到废纸篓即可。'
    fi
    exit 0
fi
if present /Library/LaunchDaemons/local.relay.network.uninstall.plist || job_exists local.relay.network.uninstall; then
    fail '自动卸载监控安装不完整，已保留组件与安装记录；不能转用旧版卸载流程。'
fi
inspect
if [ "${1:-}" = --check ]; then exit 0; fi
if [ "$app_present:$proxy_present:$tun_present" = no:no:no ] && [ -z "$active_revision" ] &&
    [ -z "$core_revision" ] && ! known_receipt_present; then
    echo '没有找到需要卸载的 Relay 安装。'
    exit 0
fi
echo '退出 Relay 后，卸载将移除本机的 Relay 系统代理和 TUN 组件，并把 /Applications/Relay.app 移到废纸篓。订阅和用户设置保留。'
if [ -n "$core_revision" ]; then echo '已确认停止的旧核心会话记录将归档。'; fi
if [ "$proxy_action" = restore ]; then
    echo '将先恢复 Relay 记录的原系统代理设置；系统应用设置时新连接可能短暂失败。恢复未确认时保留系统组件和应用程序。'
fi
confirmed_core_revision=$core_revision
confirmed_active_revision=$active_revision
confirmed_proxy_action=$proxy_action
printf '输入 UNINSTALL 继续：'
IFS= read -r reply
[ "$reply" = UNINSTALL ] || exit 0

if [ "$app_present" = yes ]; then
    trash="$user_home/.Trash"
    [ -w /Applications ] && [ -d "$trash" ] && [ ! -L "$trash" ] && [ -w "$trash" ] &&
        [ "$(/usr/bin/stat -f '%u' "$trash")" = "$user_uid" ] &&
        [ "$(/usr/bin/stat -f '%d' /Applications)" = "$(/usr/bin/stat -f '%d' "$trash")" ] ||
        fail '无法将应用程序安全移入当前用户的废纸篓。'
    destination=$(/usr/bin/mktemp -d "$trash/Relay-Uninstall.XXXXXXXX")
    trap '/bin/rmdir "$destination" 2>/dev/null || :' EXIT
    old_app_identity=$app_identity
fi
if [ "$proxy_present:$tun_present" != no:no ] || known_receipt_present; then /usr/bin/sudo -v; fi
inspect
if [ "$app_present" = yes ]; then
    [ "${old_app_identity:-}" = "$app_identity" ] || fail '应用程序在确认后被替换。'
fi
[ "$core_revision" = "$confirmed_core_revision" ] || fail '核心会话记录在确认后变化，请重新运行卸载工具。'
[ "$active_revision:$proxy_action" = "$confirmed_active_revision:$confirmed_proxy_action" ] || fail '系统代理或恢复记录在确认后变化，请重新运行卸载工具。'
if [ -n "$core_revision" ]; then
    result=$(printf '{"action":"archive","expectedRevision":"%s","context":{"home":"%s","stateRoot":"%s"}}' \
        "$core_revision" "$user_home" "$user_state" | "$native" --core-record-recovery) ||
        fail '旧核心会话记录或进程状态已变化，卸载暂停。'
    [ "$(printf '%s' "$result" | /usr/bin/plutil -extract status raw -expect string -o - -)" = archived ] &&
        [ "$(printf '%s' "$result" | /usr/bin/plutil -extract revision raw -expect string -o - -)" = "$core_revision" ] ||
        fail '旧核心会话记录未确认归档。'
fi
! present "$core_record" || fail '仍有核心会话记录，请重新运行卸载工具。'
if [ -n "$core_revision" ]; then echo '已归档停止的旧核心会话记录。'; fi

# Resolve the proxy transaction before removing its administrator backend or
# any TUN component. The native operation rechecks the confirmed revision and
# never overwrites an unrelated proxy change.
if [ -n "$active_revision" ]; then
    result=$(printf '{"action":"%s","expectedRevision":"%s","context":{"home":"%s","stateRoot":"%s"}}' \
        "$proxy_action" "$active_revision" "$user_home" "$user_state" | "$native" --system-proxy) || fail '系统代理恢复记录已变化或恢复失败，组件和应用程序仍保留。'
    result_status=$(printf '%s' "$result" | /usr/bin/plutil -extract status raw -expect string -o - -) || fail '无法确认系统代理恢复结果。'
    case "$proxy_action:$result_status" in
        restore:restored) echo '已恢复 Relay 记录的原系统代理设置。';;
        retireDetached:inactive) echo '已归档脱离系统代理的 Relay 恢复记录。';;
        *) fail '系统代理恢复未确认，组件和应用程序仍保留。';;
    esac
    ! present "$user_state/SystemProxy/active.json" || fail '系统代理恢复记录仍在使用，组件和应用程序仍保留。'
fi
require_idle
[ -z "$core_revision$active_revision" ] || fail '出现新的核心或代理会话记录，卸载暂停。'
# Reuse the root-owned uninstallers for the actual removals. Their own
# manifest checks and TUN lifetime lock guard the privileged operations.
if [ "$tun_present" = yes ]; then
    /usr/bin/sudo "$tun/uninstall.py" --remove "$tun_digest" || fail 'TUN 组件卸载失败，应用程序仍保留。'
    echo 'TUN 组件已移除。'
fi
require_idle
[ -z "$core_revision$active_revision" ] || fail '出现新的核心或代理会话记录，卸载暂停。'
if [ "$proxy_present" = yes ]; then
    /usr/bin/sudo "$proxy/uninstall" || fail '系统代理组件卸载失败，应用程序仍保留。'
    echo '系统代理组件已移除。'
fi
require_idle
[ -z "$core_revision$active_revision" ] || fail '出现新的核心或代理会话记录，卸载暂停。'
if present "$proxy" || present "$tun" || present "$helper" || present "$daemon" ||
    job_exists local.relay.network.system-proxy || job_exists local.relay.network.tun; then
    fail '组件卸载后仍有残留，应用程序仍保留。'
fi
# An interrupted older uninstaller may have removed its files before forgetting
# the receipt. With all fixed component paths and jobs absent, only these exact
# Relay receipt IDs remain safe to retire; unrelated receipts are preserved.
receipts=$(/usr/sbin/pkgutil --pkgs) || fail '无法复核组件卸载后的安装记录。'
for installed in "$app_receipt" "$proxy_receipt" local.relay.network.tun.core-managed-v1 local.relay.network.tun.core-managed-v2; do
    if receipt_exists "$installed"; then /usr/bin/sudo /usr/sbin/pkgutil --forget "$installed" >/dev/null; fi
done
receipts=$(/usr/sbin/pkgutil --pkgs) || fail '无法确认安装记录已移除。'
if known_receipt_present; then fail 'Relay 安装记录仍有残留，应用程序仍保留。'; fi
if [ "$app_present" = yes ]; then
    [ "$(/usr/bin/stat -f '%d:%i' "$app")" = "$app_identity" ] || fail '应用程序在确认后被替换。'
    /bin/mv "$app" "$destination/Relay.app"
fi
echo 'Relay 已卸载。安装包和用户配置可用于重新安装。'
