# Positive-lineage ES source package

This is a separate EndpointSecurity system extension with the fixed identity
`local.relay.network.preview.guard.lineage`. It observes known Claude roots,
native Codex CLI launches with verified Apple Terminal origin, and their
process ancestry. Scoped AUTH_EXEC candidates wait for an authenticated NE
pre-execution claim before execution is permitted. Ordinary unclaimed
executions take a separate fast path. The NE Provider is its only protocol
client. The ordinary App remains usable when this optional
component is absent.

The compiled SourceRelease and Guard release authorities remain disabled. Team
and architecture resource pins are null; `completeClientScopeReady` remains
false. Source presence, successful compilation, an ES health frame, or a
development candidate never establishes installed or active protection.

`scripts/relay/build-guard-lineage.py` defaults to metadata validation only.
`--check-source --output <new-private-directory>` explicitly performs source
typechecking for arm64 and x86_64. `--build` explicitly emits raw development
bundles in separate architecture directories. A compiler/linker may include its
development signature; it is not publisher signing. None of these modes signs,
executes, installs, activates, grants permissions, or changes system settings.
The dual-architecture development archive can contain these raw bundles.

The source plan keeps the ES entrypoint/monitor out of the Main and NE source
closures. The wire, resource identity, execution-generation type and pure
libbsm audit-accessor header are shared; the NE client never imports or links
EndpointSecurity. The ES executable links EndpointSecurity explicitly.

Info uses the SDK's `NSEndpointSecurityMachServiceName`; it is not a LaunchDaemon
`MachServices` dictionary or a NetworkExtension provider declaration. The
extension owns the ES client entitlement. Main receives only its separate
system-extension installation/application-group entitlement fragment. Existing
identical host keys must be merged explicitly at publication, preserving the
NE capability rather than overwriting it. Early-boot execution/mount gating is
deliberately absent.

Development output is kept outside the ordinary App. The separate [publisher
packaging workflow](../../package/RELEASE.md) embeds the signed components in a
private App copy and verifies the outer seal. The publisher supplies the
reviewed release source, matching signed components, approved entitlements and
fresh post-sign resource pins. Notarization and system authorization are
separate. The pairing verifier checks the outer App short version against
`package.json` and the component short versions against the numeric release
base.

Terminal CLI attribution requires a verified Apple Terminal origin and a
separately verified CLI identity. Unclaimed Terminal, shells and ordinary Node
commands follow the ordinary execution path. The official Claude npm 2.1.100
direct shebang is checked against a fixed verified script digest as launch
provenance. Node's later loading of that path and interpreter-argument launches
are separate cases.
The AUTH scheduling slice uses the canonical installed
`node_modules/@anthropic-ai/claude-code/cli.js` path. A matching digest at a
relocated copy path does not establish coverage by this early scheduling gate.
The wire rejects differing component architecture/timebase clock domains.

AUTH_EXEC has an independent early response deadline, a provisional future
execution identity and an exact Provider/Core acknowledgement. Only accepted
client ALLOW plus an aggregate successful execution notification commits that
identity. Uncertain delivery keeps restrictive attribution. A miss of the
kernel deadline may implicitly allow execution, so the local timer does not
establish protection after ES loss or scheduling failure. Parent/responsible
kernel audit tokens may positively recover an already open Terminal shell.
For a positively identified execution, a socket in the public AUTH_EXEC
descriptor list is grounds to deny the handoff. That list is a subset. Its
silence does not prove that a process has no inherited sockets.

When the NE client reconnects to a healthy ES source, it learns the source's
retained positive generations and pending execution reservations in bounded
pages. It waits for the final page and the stated update watermark before
accepting new claims or using source permits. Membership alone grants no
permit. This restores known identity for new flows. It does not enumerate
running processes or bring established flows under the filter.

Fork-only first-flow races, unproven existing shells, existing or inherited
flows and unknown script executions remain deployment blockers.
The current Provider only claims positively attributed or directly verified
Desktop candidates. Pending protected flows fail closed on source loss. Full
coverage remains disabled.

See `UPSTREAM.json` and `LICENSE.Santa.txt` for the narrowly adopted mature ES
package layout. The reference to uncached execution authorization uses the fixed Santa authorizer. No global execution policy database or early-boot barrier is adopted.
