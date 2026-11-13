#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Offline system proxy helper build refuses root and arguments.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
source_dir="$project_dir/native/system-proxy"
build_dir="${RELAY_SYSTEM_PROXY_HELPER_BUILD_DIR:-$project_dir/.relay-build/system-proxy-helper}"
reuse_dir="${RELAY_SYSTEM_PROXY_HELPER_REUSE_BUILD_DIR:-}"
if [[ "$build_dir" != /* || -e "$build_dir" || -L "$build_dir" ]]; then
  print -u2 'Choose a new, absolute build output directory; existing outputs are not overwritten.'
  exit 77
fi
mkdir -p "$build_dir"
common=("$project_dir/native/RelaySystemProxyBackend.swift" "$source_dir/RelaySystemProxyHelperTrust.swift" "$source_dir/RelaySystemProxyHelperWire.swift")
shipping_sources=("${common[@]}" "$source_dir/RelaySystemProxyHelperMain.swift" "$source_dir/RelaySystemProxyClientMain.swift"
  "$source_dir/package/common.sh" "$source_dir/package/preinstall" "$source_dir/package/postinstall" "$source_dir/package/uninstall"
  "$project_dir/scripts/relay/build-system-proxy-helper.zsh")
python3 - "$project_dir" "$build_dir/source-before.json" "${shipping_sources[@]}" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
files={str(pathlib.Path(p).relative_to(root)):hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest() for p in sys.argv[3:]}
pathlib.Path(sys.argv[2]).write_text(json.dumps({"version":1,"files":files},indent=2,sort_keys=True)+"\n")
PY
frameworks=(-framework Foundation -framework Security -framework CryptoKit -framework SystemConfiguration)
if [[ -n "$reuse_dir" ]]; then
  # Installer-only updates keep the previously delivered client/helper code
  # identities. The exact native sources and signed bytes must still match.
  python3 - "$project_dir" "$build_dir" "$reuse_dir" <<'PY'
import hashlib,json,pathlib,shutil,subprocess,sys
root,output,previous=map(pathlib.Path,sys.argv[1:])
if not previous.is_absolute(): raise RuntimeError('Reuse build must be an absolute path')
receipt=json.loads((previous/'build-receipt.json').read_text()); plan=json.loads((previous/'package-plan.json').read_text())
if receipt.get('passed') is not True or receipt.get('architectures')!=['arm64','x86_64']: raise RuntimeError('Unknown previous build')
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
native=['native/RelaySystemProxyBackend.swift']+['native/system-proxy/RelaySystemProxy'+name+'.swift' for name in ['HelperTrust','HelperWire','HelperMain','ClientMain']]
for name in native:
    if digest(root/name)!=receipt['sourceSHA256'].get(name): raise RuntimeError('Native source changed; cannot reuse code identity: '+name)
for target,key in [('Helper','helper'),('Client','client')]:
    name='RelaySystemProxy'+target; source=previous/name; pin=plan['template'][key]
    if digest(source)!=pin['sha256'] or source.stat().st_size!=pin['size']: raise RuntimeError('Previous binary does not match its build pin')
    subprocess.run(['/usr/bin/codesign','--verify','--strict','--all-architectures',str(source)],check=True)
    shutil.copyfile(source,output/name); (output/name).chmod(0o755)
(output/'reused-runtime.json').write_text(json.dumps({'buildReceiptSHA256':digest(previous/'build-receipt.json'),'sourceBuild':str(previous),'sourceSHA256':{name:receipt['sourceSHA256'][name] for name in native}},indent=2)+'\n')
PY
else
for architecture in arm64 x86_64; do
  for target in Helper Client; do
    xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -target "$architecture-apple-macosx13.0" \
      -module-cache-path "$build_dir/ModuleCache-$architecture" "${common[@]}" "$source_dir/RelaySystemProxy${target}Main.swift" \
      "${frameworks[@]}" -o "$build_dir/RelaySystemProxy$target-$architecture"
  done
done
for target in Helper Client; do
  binary="RelaySystemProxy$target"
  lipo -create "$build_dir/$binary-arm64" "$build_dir/$binary-x86_64" -output "$build_dir/$binary"
  codesign --force --sign - --identifier "local.relay.network.system-proxy.$binary" --options runtime --timestamp=none "$build_dir/$binary"
  codesign --verify --strict --all-architectures "$build_dir/$binary"
done
fi
python3 - "$project_dir" "$build_dir" <<'PY'
import hashlib,json,os,pathlib,plistlib,re,shutil,subprocess,sys
root,output=map(pathlib.Path,sys.argv[1:]); source=root/'native/system-proxy/package'; scripts=output/'Scripts'; scripts.mkdir(mode=0o755)
service='local.relay.network.system-proxy'
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def pin(path):
    hashes={}
    for arch in ['arm64','x86_64']:
        detail=subprocess.run(['/usr/bin/codesign','-d','--verbose=4','--arch',arch,str(path)],capture_output=True,text=True,check=True).stderr
        hashes[arch]=re.search(r'^CDHash=([0-9a-f]{40})$',detail,re.M)[1]
        if not re.search(r'^CodeDirectory .*flags=.*runtime',detail,re.M): raise RuntimeError('Missing hardened runtime')
        ent=subprocess.run(['/usr/bin/codesign','-d','--entitlements',':-','--arch',arch,str(path)],capture_output=True,check=True).stdout
        if ent.strip() and plistlib.loads(ent): raise RuntimeError('Unexpected entitlements')
    return {'sha256':digest(path),'size':path.stat().st_size,'cdhashes':hashes}
helper=pin(output/'RelaySystemProxyHelper'); client=pin(output/'RelaySystemProxyClient')
daemon=scripts/(service+'.plist')
daemon.write_bytes(plistlib.dumps({'Label':service,'ProgramArguments':['/Library/PrivilegedHelperTools/'+service,'--serve'],'MachServices':{service:True},'AssociatedBundleIdentifiers':['local.relay.network.preview'],'ProcessType':'Background','RunAtLoad':False,'KeepAlive':False},sort_keys=True)); daemon.chmod(0o644)
tokens={'@HELPER_SHA256@':helper['sha256'],'@HELPER_SIZE@':str(helper['size']),'@CLIENT_SHA256@':client['sha256'],'@CLIENT_SIZE@':str(client['size']),'@DAEMON_SHA256@':digest(daemon)}
def script(name):
    text='#!/bin/sh\nset -eu\n'+(source/'common.sh').read_text()+'\n'+(source/name).read_text()
    for key,value in tokens.items(): text=text.replace(key,value)
    if re.search(r'@[A-Z_0-9]+@',text): raise RuntimeError('Unresolved package token: '+name)
    path=scripts/name; path.write_text(text); path.chmod(0o755)
    subprocess.run(['/bin/sh','-n',str(path)],check=True)
    return path
uninstall=script('uninstall')
template={'version':1,'role':'system-proxy-v1','clientUID':0,'helper':helper,'client':client,'daemonSHA256':digest(daemon),'uninstallerSHA256':digest(uninstall)}
template_path=scripts/'installation.template.json'; template_path.write_text(json.dumps(template,sort_keys=True,separators=(',',':'))+'\n'); template_path.chmod(0o644)
tokens.update({'@UNINSTALLER_SHA256@':digest(uninstall),'@TEMPLATE_SHA256@':digest(template_path)})
script('preinstall'); script('postinstall')
for target in ['Helper','Client']:
    target_path=scripts/('RelaySystemProxy'+target); shutil.copyfile(output/target_path.name,target_path); target_path.chmod(0o755)
shutil.copyfile(uninstall,output/'Recover-System-Proxy-Installation.sh'); (output/'Recover-System-Proxy-Installation.sh').chmod(0o755)
readme='''Relay 系统代理管理员组件（自用版）

适用于 macOS 13 及以上，包含 Apple Silicon 与 Intel 原生组件。安装只使用系统自带工具，无需 Xcode、Python 或其他开发工具。
打开 Relay-System-Proxy-Helper-v1.pkg，macOS 会要求本次安装的管理员授权。
安装绑定当前登录桌面的普通用户，只安装独立组件；不启动代理内核，不修改当前系统代理、路由、DNS 或 TUN。
授权范围是：该绑定用户通过固定且摘要匹配的 RelaySystemProxyClient 管理系统 Proxies 协议的完整代理字典（包括 PAC 设置及恢复）。调用权限不只限于 Relay GUI 进程。组件不提供 DNS、TUN、进程管理或任意命令执行接口。
组件为本机自用 ad-hoc 签名，不含 Developer ID 或公证。
本交付已完成离线编译、签名和包内容核对及替身脚本验证；未实际安装，真实 root/XPC 通信和系统代理写入尚未进行本次验收。

正常卸载：sudo "/Library/Application Support/Relay/SystemProxy/uninstall"
卸载只移除该组件，保留当前系统代理和现有连接。建议先在 Relay 关闭系统代理；卸载后仍可通过 Relay 原有管理员授权流程恢复先前设置。
卸载不修改 TUN、Clash Party、Relay 配置或恢复记录，不删除共享 Relay 父目录。

安装或卸载中断时，可运行本包的 Recover-System-Proxy-Installation.sh（需 sudo）。
恢复脚本只处理同版本管理员所有、摘要匹配的固定组件文件和登记的临时文件；未知文件或版本不匹配会拒绝删除。
已有组件会阻止安装。请用该组件配套的卸载或恢复工具清理，随后安装新组件。
'''
(output/'README.txt').write_text(readme)
(output/'package-plan.json').write_text(json.dumps({'version':1,'service':service,'receipt':'local.relay.network.system-proxy.v1','template':template,'recoverySHA256':digest(output/'Recover-System-Proxy-Installation.sh'),'networkChanged':False,'installed':False,'scriptsOnly':True,'freshInstallOnly':True},indent=2,sort_keys=True)+'\n')
PY
/usr/bin/pkgbuild --nopayload --scripts "$build_dir/Scripts" --identifier local.relay.network.system-proxy.v1 --version 1.0.1 --install-location / "$build_dir/Relay-System-Proxy-Helper-v1.pkg"
/usr/sbin/pkgutil --expand "$build_dir/Relay-System-Proxy-Helper-v1.pkg" "$build_dir/expanded"
python3 - "$project_dir" "$build_dir" <<'PY'
import hashlib,json,pathlib,sys
root,output=map(pathlib.Path,sys.argv[1:]); before=json.loads((output/'source-before.json').read_text())
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
for name,sha in before['files'].items():
    if digest(root/name)!=sha: raise RuntimeError('Source changed during build: '+name)
for original in (output/'Scripts').iterdir():
    expanded=output/'expanded/Scripts'/original.name
    if not expanded.is_file() or digest(expanded)!=digest(original): raise RuntimeError('Expanded package differs: '+original.name)
(output/'shipping-sources.json').write_text(json.dumps(before,indent=2,sort_keys=True)+'\n')
receipt={'passed':True,'installed':False,'networkChanged':False,'realServiceStarted':False,'architectures':['arm64','x86_64'],'sourceSHA256':before['files'],'packageSHA256':digest(output/'Relay-System-Proxy-Helper-v1.pkg'),'recoverySHA256':digest(output/'Recover-System-Proxy-Installation.sh'),'expandedScriptsVerified':True,'freshInstallOnly':True}
(output/'build-receipt.json').write_text(json.dumps(receipt,indent=2,sort_keys=True)+'\n')
PY
print 'Independent universal system proxy helper and installer built. Nothing installed, launched or changed on this host.'
