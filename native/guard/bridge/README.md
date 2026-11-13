# Native Main host source

This library runs in the signed Electron Main process through raw Node-API, not
through the short-lived RelayNative command executor. Current publication values
remain nil/false and reject every real management operation.

A local prepared Core proof is separate from a Provider receipt. The Apple
sample saves isEnabled before it registers XPC. Accordingly, enabling requires
fresh native local proof and explicit default-cancel native confirmation, then
save/readback; the Provider may start unbound and drops protected flows until a
signed binding arrives. Only a fresh ready receipt can pass the client gate.
Status never retries a binding or changes filter configuration.

Native sheets yield the Main loop. Main's frame/epoch check and a revocation-only
native atomic epoch invalidate pending intent. Before a system write native code
rechecks it; loss after submission retains fresh facts as uncertain. It does not
blindly roll back or repeat activation. Disabling an owned configuration remains
available when XPC is disconnected, with its own explicit ownership/consent gate.

Core write barriers reserve against management/native pending work, revoke the
lease before admitted writes and use a typed refusal without corrupting Core
facts. Main holds pending/uncertain/enabled-filter exit obligations. No shutdown
path silently disables the filter.

Static compilation is source evidence only. Exact listener proof is currently
Darwin24-specific; no supported OS/protection or complete external Node/tool
coverage is claimed. The scoped CLI is a separate explicitly limited source
slice. See UPSTREAM.json and the independent admission manifest.

A bind may have reached the Provider even when its reply/connection is lost.
remoteBindMayExist is set before sending and survives connection loss. Only a
verified revoke acknowledgement or a fresh owned disabled NE observation clears
it; unresolved delivery is reported unconfirmed and blocks Core writes/enable.
Preparation while the configuration is not enabled never attempts XPC, avoiding
both a bootstrap cycle and a false remote acknowledgement.
