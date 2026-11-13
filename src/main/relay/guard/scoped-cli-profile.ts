// Minimal adaptation of Anthropic sandbox-runtime 27fce0db macOS SBPL.
// Its optional Mach/Unix/listen/AppleEvent permissions are deliberately absent.
// Works only for the explicitly launched tree; never changes system Node/CLI.
export function scopedCLIProfile(
  port: number,
  home: string,
  work: string,
  protectedPaths: readonly string[]
): string {
  if (
    !Number.isInteger(port) ||
    protectedPaths.length !== 5 ||
    port < 1024 ||
    port > 65535 ||
    [home, work, ...protectedPaths].some(
      (path) => !path.startsWith('/') || path.includes('\0') || path.includes('\n')
    )
  )
    throw new Error('受限 CLI 目录或代理端口未确认。')
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow process-info* (target same-sandbox))',
    '(allow signal (target same-sandbox))',
    '(allow file-read*)',
    '(allow sysctl-read)',
    `(allow file-write* (subpath ${JSON.stringify(home)}) (subpath ${JSON.stringify(work)}) (literal "/dev/null"))`,
    '(allow file-ioctl (literal "/dev/null"))',
    // Prevent chmod/ACL/rename of the covered host anchor and its parents.
    // After ordinary unmount its verified 0500/empty-ACL DAC prevents recreating
    // home/work even when a surviving descendant still has these SBPL paths.
    `(deny file-write* ${protectedPaths.map((path) => `(literal ${JSON.stringify(path)})`).join(' ')})`,
    '(deny process-exec (literal "/usr/bin/sudo") (literal "/usr/bin/su"))',
    // TCP only. No UDP, DNS, other loopback ports, bind/listen, Unix socket,
    // Mach lookup, Apple Events, launchd or Terminal delegation permission.
    `(allow network-outbound (remote tcp "localhost:${port}"))`
  ].join('\n')
}
