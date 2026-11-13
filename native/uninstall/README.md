# Automatic Trash uninstall

The integrated Installer installs a root-owned `RelayUninstallSupervisor` and a
byte-identical copy of the sealed App's `RelayNative` under
`/Library/Application Support/Relay/Uninstall`. It registers the fixed installed
App and console account only after the App and proxy helper installation succeed.
Installation is not successful until the independent LaunchDaemon confirms that
it is monitoring the registered App. No main App, core or network operation is
started by the Installer.

The supervisor exists outside `Relay.app` so dragging the App to Trash can start
cleanup even after the main App has quit. The watched file identity, current
location and installation generation are the trigger. A missing original path,
an ordinary move, or replacement during an update is not sufficient evidence of
uninstall intent. An unlinked held vnode also admits cleanup, covering immediate
emptying of Trash and direct deletion. The current Installer rejects an existing
App and the App opens that Installer rather than replacing its bundle itself;
any future updater that unlinks the old bundle before installing a replacement
must add an explicit update transaction guard. User restoration runs as the bound ordinary user; privileged
component removal uses the existing fixed-path, owner-checked uninstall paths.
The monitor removes itself last.

## Reviewed implementations and fixed sources

- **Apple XNU** commit
  [`f6217f891ac0bb64f3d375211650a4c1ff8ca1ea`](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_descrip.c#L3805):
  `F_GETPATH` obtains the current path from an already-open vnode. The design uses
  the public `open`/`fstat`/`fcntl` interfaces, not copied kernel code. The call
  still passes the MAC policy hook, so an access failure must remain a failure,
  never proof that the App was deleted. [Apple DTS's directory-tracking
  guidance](https://developer.apple.com/forums/thread/815285) recommends this
  approach and describes why cached NSURL paths/file identities and FSEvents
  alone are insufficient for tracking a moved directory.
- **Pearcleaner Sentinel** commit
  [`7724df7111bff82ae243301cf701992ef05ecf19`](https://github.com/alienator88/Pearcleaner/blob/7724df7111bff82ae243301cf701992ef05ecf19/PearcleanerSentinel/main.swift#L15):
  reviewed its independent LaunchAgent, FSEvents callback and
  `FileManager.getRelationship(.trashDirectory)` validation. The implementation
  explicitly skips Pearcleaner itself, and therefore does not supply self
  uninstall. Its [Apache 2.0 + Commons Clause license](https://github.com/alienator88/Pearcleaner/blob/7724df7111bff82ae243301cf701992ef05ecf19/LICENSE.md)
  is not a plain permissive license. No source is copied. Relay watches its own
  registered App FD instead of enumerating the user's Trash, which [Apple
  documents as requiring Full Disk Access](https://developer.apple.com/videos/play/wwdc2019/701/?time=1995).
- **Clash Verge service IPC** commit
  [`3ed29700b093190b5e7addcaa892e77f172af544`](https://github.com/clash-verge-rev/clash-verge-service-ipc/blob/3ed29700b093190b5e7addcaa892e77f172af544/src/bin/uninstall_service.rs#L107):
  reviewed the explicit `launchctl` stop/disable/bootout and fixed helper/plist
  removal chain. It has no automatic Trash trigger. Relay retains its existing
  stricter fixed-path ownership and transaction cleanup rather than importing a
  second service manager.
- **Electron 43.0.0** commit
  [`5147ac2d278f105ec0801c1ef021709979f6d428`](https://github.com/electron/electron/blob/5147ac2d278f105ec0801c1ef021709979f6d428/shell/browser/browser_mac.mm#L447):
  traced `app.setLoginItemSettings` through `Browser::SetLoginItemSettings` to
  [`platform_util::SetLoginItemEnabled`](https://github.com/electron/electron/blob/5147ac2d278f105ec0801c1ef021709979f6d428/shell/common/platform_util_mac.mm#L243).
  On macOS 13+, the ordinary main-App login item is controlled by
  `SMAppService.mainApp`; an external native process cannot assume that this API
  targets `Relay.app`. The old LSSharedFileList branch only handles legacy
  registrations. No Electron source is copied.
- **Electron 43.8.0 safeStorage**, commit
  [`071a136f896e2a4b6c4dacc65bee38678f00e0bd`](https://github.com/electron/electron/blob/071a136f896e2a4b6c4dacc65bee38678f00e0bd/shell/browser/electron_browser_main_parts.cc#L692):
  the service is `app_name + " Safe Storage"` and the account is `app_name`.
  Relay explicitly sets its name to `Relay`, so only the generic-password item
  with service `Relay Safe Storage` and account `Relay` is eligible for removal.
  Its pinned Chromium 150.0.7871.250 commit
  [`f916f1b7136907af19d96b95b891533d091d932a`](https://github.com/chromium/chromium/blob/f916f1b7136907af19d96b95b891533d091d932a/crypto/apple/keychain_v2.mm#L106)
  uses these exact `SecItem` attributes, without opting into the data-protection
  keychain. Do not remove a generic Chromium/Chrome item or change the keychain
  implementation in the deletion query. The ordinary user's GUI context does
  not override a Keychain ACL; a noninteractive authorization failure remains a
  failure. [Apple documents](https://developer.apple.com/documentation/security/ksecuseauthenticationuifail)
  that disallowed authentication returns `errSecInteractionNotAllowed` and now
  recommends `LAContext.interactionNotAllowed` for noninteractive queries.

## Limits and verification boundary

Moving an App to Trash is not an OS-provided arbitrary cleanup hook. The
independent monitor and Relay's own restoration records are required.
[Apple DTS](https://developer.apple.com/forums/thread/783433) notes that the OS
cannot generally know when an App has really been deleted; SMAppService metadata
cleanup must not be assumed to replace explicit unregistering. Likewise, root
does not bypass macOS privacy policy.

Installer fixtures replace system commands and fixed paths inside a disposable
directory. They cover publication order, existing installation refusal, account
binding, readiness and failure cleanup without installing a daemon or changing
network settings. Actual Finder Trash delivery and protected-directory access
remain separate from these offline tests.

`scripts/relay/test-uninstall-supervisor-components.py` compiles copies of the
actual Support and Components sources with strictly counted substitutions for
the fixed namespace, owner UID and ancestor-check boundary. It exercises real
file descriptors, file modes, symlink/hardlink rejection, lifetime `flock`,
managed v1/v2 deletion and partial-removal recovery, exact receipt retirement,
and unrelated replacement refusal. A real DispatchSource test observes rename
and delete events on a continuously held directory FD. On the tested APFS
filesystem, deleting the directory makes `fstat` return `ENOENT` while
`F_GETPATH` retains the last location; tests must not assume `st_nlink == 0` is
always available after deletion. Production code has no fixture environment
switch. A separate subprocess opens an App directory FD, then observes a rename
into a disposable directory whose enumeration is denied by a local sandbox
policy. `F_GETPATH` still resolves the held vnode in that test. This is evidence
for the FD mechanism under a MAC restriction, not a claim that real user Trash
TCC/FDA conditions were exercised.
