# TUN readiness API contract

`mihomo-3f27-tun-readiness.json` is generated from the pinned Mihomo commit
`3f27ef39f8c96bbfbc8b0b9bb10f5c9ef60149d8` with sing-tun `v0.4.28`.
The source and license pins are recorded in `core-extensions/SOURCE.md`.

`mihomo-tun-readiness.go` runs only the upstream configuration parser and the
`executor.GetGeneral().Tun` serializer used by `/configs`. It never applies a
configuration, creates a listener/device, or changes network settings. All inputs
are synthetic; no user configuration is used.

On Darwin, compile the generator from the verified upstream module directory using
the same Go toolchain and tags (`relay_local_geodata,with_gvisor`) as the core.
Run it as an ordinary user with networking denied:

```sh
sandbox-exec -p '(version 1) (allow default) (deny network*)' /path/to/generator
```

The omitted and empty `dns-mode` cases serialize as an empty string.
`DNSModeOrDefault()` evaluates those cases to `disabled` on Darwin without
changing the serialized option. Explicit values are preserved.
The Swift readiness tests use these parser-produced values for startup, runtime
capture and supplied-FD validation, including malformed and changed responses.
