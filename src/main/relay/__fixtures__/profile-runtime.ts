export const profileRuntimeSource = `# synthetic offline fixture
mixed-port: 7890
dns: {enable: true, nameserver-policy: {business.invalid: 10.0.0.53}}
tun: {enable: true}
external-controller: 0.0.0.0:9090
unknown-setting: PRIVATE-untested
proxies:
  - {name: Node, type: ss, server: 127.0.0.1, port: 12345, cipher: aes-128-gcm, password: PRIVATE-password}
proxy-groups:
  - {name: Group, type: select, proxies: [Node, DIRECT]}
rules: ['DOMAIN-SUFFIX,example.invalid,Group', 'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve', 'MATCH,Group']
`
