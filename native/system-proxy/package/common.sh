# Included in the generated, fixed-path installer and uninstaller scripts.
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
umask 077
service=local.relay.network.system-proxy
receipt=local.relay.network.system-proxy.v1
relay='/Library/Application Support/Relay'
root="$relay/SystemProxy"
helper="/Library/PrivilegedHelperTools/$service"
client="$root/RelaySystemProxyClient"
daemon="/Library/LaunchDaemons/$service.plist"
manifest="$root/installation.json"
pending="$root/installation.pending.json"
uninstaller="$root/uninstall"
fail() { echo "Relay system proxy component refused: $*" >&2; exit 1; }
present() { [ -e "$1" ] || [ -L "$1" ]; }
absent() { if present "$1"; then fail "already present: $1"; fi; }
digest() { /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'; }
directory() {
    [ -d "$1" ] && [ ! -L "$1" ] || fail "unsafe directory: $1"
    [ "$(/usr/bin/stat -f '%u' "$1")" = 0 ] || fail "directory is not administrator-owned: $1"
    permissions=$(/usr/bin/stat -f '%Lp' "$1") || fail 'directory metadata'
    [ "$((0$permissions & 06022))" = 0 ] || fail "writable directory: $1"
}
parents() {
    [ "$(/usr/bin/id -u)" = 0 ] || fail 'administrator authorization required'
    for parent in / /Library '/Library/Application Support' /Library/LaunchDaemons; do directory "$parent"; done
    if [ "${1:-inspect}" = create ] && ! present /Library/PrivilegedHelperTools; then /bin/mkdir -m 755 /Library/PrivilegedHelperTools; fi
    directory /Library/PrivilegedHelperTools
    if present "$relay"; then directory "$relay"; fi
}
regular() {
    [ -f "$1" ] && [ ! -L "$1" ] || fail "unsafe file: $1"
    [ "$(/usr/bin/stat -f '%u:%Lp:%l' "$1")" = "0:$2:1" ] || fail "file ownership, mode or links: $1"
}
pinned() {
    regular "$1" "$2"
    [ "$(digest "$1")" = "$3" ] || fail "file differs from this package: $1"
}
console_uid() {
    console=$(/usr/bin/stat -f '%u' /dev/console) || fail 'console user unavailable'
    case "$console" in ''|*[!0-9]*) fail 'invalid console user';; esac
    [ "$console" -gt 0 ] && [ "$console" -lt 4294967295 ] || fail 'an ordinary logged-in console user is required'
}
value() { /usr/bin/plutil -extract "$1" raw -o - "$plan"; }
validate_plan() {
    regular "$plan" "$plan_mode"
    [ "$(value version)" = 1 ] && [ "$(value role)" = system-proxy-v1 ] || fail 'unknown installation role'
    [ "$(value helper.sha256)" = '@HELPER_SHA256@' ] && [ "$(value helper.size)" = '@HELPER_SIZE@' ] || fail 'helper pin mismatch'
    [ "$(value client.sha256)" = '@CLIENT_SHA256@' ] && [ "$(value client.size)" = '@CLIENT_SIZE@' ] || fail 'client pin mismatch'
    [ "$(value daemonSHA256)" = '@DAEMON_SHA256@' ] || fail 'daemon pin mismatch'
    bound_uid=$(value clientUID) || fail 'missing bound user'
    case "$bound_uid" in ''|*[!0-9]*) fail 'invalid bound user';; esac
    [ "$bound_uid" -gt 0 ] && [ "$bound_uid" -lt 4294967295 ] || fail 'invalid bound user'
}
service_absent() {
    if /bin/launchctl print "system/$service" >/dev/null 2>&1; then fail 'service already registered'; else result=$?; [ "$result" = 113 ] || fail 'service inventory unavailable'; fi
}
