"""Tests the real Swift bridge. Input documents only; no actual settings or network."""
from pathlib import Path
import subprocess,json,plistlib
exe=Path('extra/relay/RelayNative').resolve()
results=[]
def check(name,condition):
 results.append({'name':name,'passed':bool(condition)})
def invoke(payload):
 return subprocess.run([str(exe),'--preview'],input=json.dumps(payload),capture_output=True,text=True,timeout=15)
base={'httpPort':8888,'node':'fixture-node','internalExceptions':'git.corp,10.10.0.5','existingJSON':json.dumps({'custom':'keep','env':{'CUSTOM':'stay','BROWSER':'/existing/browser','NO_PROXY':'.com,.ai,*:443,.corp'}})}
r=invoke(base);check('native preview succeeds',r.returncode==0)
d=json.loads(r.stdout);s=json.loads(d['settingsJSON']);env=s['env']
check('preserves unrelated fields',s['custom']=='keep' and env['CUSTOM']=='stay')
check('keeps current BROWSER',env['BROWSER']=='/existing/browser')
check('four proxy vars',all(env[x]=='http://127.0.0.1:8888' for x in ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy']))
check('internal bypass preserved',all(x in env['NO_PROXY'].split(',') for x in ['.corp','git.corp','10.10.0.5']))
check('public and wildcard bypass removed',all(x not in env['NO_PROXY'].split(',') for x in ['.com','.ai','*:443']))
check('eight domain rules generated',d['plan'].count('DOMAIN-SUFFIX,')==8)
check('separate rules fragment',d['rules'].startswith('rules:') and d['rules'].count('DOMAIN-SUFFIX,')==8)
check('separate dns fragment',d['dns'].startswith('dns:') and d['dns'].count('dns-query#fixture-node')==8)
check('separate listener fragment',d['listeners'].startswith('listeners:') and 'port: 17890' in d['listeners'])
check('warning clearly states no application',any('未读取或写入' in x for x in d['warnings']))
for name,patch in [('bad env',{'existingJSON':'{"env":[]}'}),('bad root',{'existingJSON':'[]'}),('bad proxy port',{'httpPort':17890}),('invalid JSON',{'existingJSON':'password=do-not-log-me'}),('no_proxy wrong type',{'existingJSON':'{"env":{"NO_PROXY":[]}}'})]:
 r=invoke({**base,**patch});check(name+' refused',r.returncode!=0 and not r.stdout)
 check(name+' raw input not logged','do-not-log-me' not in r.stderr)
for args in [[],['--status'],['--apply'],['--preview','--apply']]:
 r=subprocess.run([str(exe),*args],capture_output=True,text=True,timeout=10)
 check('unsupported native entry '+str(args),r.returncode!=0)
r=subprocess.run([str(exe),'--simulate'],capture_output=True,text=True,timeout=10)
check('real simulation entry succeeds',r.returncode==0)
sim=json.loads(r.stdout)
check('simulation has ten expected decisions',len(sim['rows'])==10 and all(row['passed'] and row['expected']==row['actual'] for row in sim['rows']))
check('simulation does not claim real protection',sim['protected'] is False and len(sim['warnings'])==2)
r=subprocess.run([str(exe),'--edge-profile'],capture_output=True,text=True,timeout=10)
check('pure Edge profile entry succeeds',r.returncode==0)
edge=json.loads(r.stdout);profile=plistlib.loads(edge['profileXML'].encode());policy=profile['PayloadContent'][0]
check('Edge profile is uninstalled output',edge['installed'] is False and len(edge['warnings'])==3)
check('user-scoped removable profile',profile['PayloadScope']=='User' and profile['PayloadRemovalDisallowed'] is False)
check('only Edge is managed',len(profile['PayloadContent'])==1 and policy['PayloadType']=='com.microsoft.Edge')
check('fixed SOCKS with loopback bypass',policy['ProxySettings']=={'ProxyMode':'fixed_servers','ProxyServer':'socks5://127.0.0.1:17890','ProxyBypassList':'localhost;*.localhost;127.0.0.1;[::1]'})
check('all privacy policies preserved',policy['DnsOverHttpsMode']=='off' and policy['WebRtcLocalhostIpHandling']=='disable_non_proxied_udp' and policy['NetworkPredictionOptions']==2)
for kind in ['Shadowsocks','Selector','Unrecognized','Direct']:
 r=subprocess.run([str(exe),'--guard-plan'],input=json.dumps({'node':'fixture-node','proxyTypes':{'fixture-node':kind}}),capture_output=True,text=True,timeout=10)
 check('guard plan leaf type '+kind,(r.returncode==0)==(kind=='Shadowsocks'))
 if kind=='Shadowsocks':check('guard plan only text', '尚未' in json.loads(r.stdout)['plan'] and 'port: 17891' in json.loads(r.stdout)['plan'])
# This deliberately fails decoding BEFORE any diagnostic environment is created.
r=subprocess.run([str(exe),'--diagnose'],input='{}',capture_output=True,text=True,timeout=10)
check('diagnostic malformed request fails before OS observations',r.returncode!=0 and not r.stdout)
report={'checks':len(results),'passed':sum(x['passed'] for x in results),'results':results,'scope':'Compiled native bridge, JSON input only, no live diagnose/GUI/network/configuration operation.'}
Path('../evidence/native-bridge-tests.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:report[k] for k in ['checks','passed']},ensure_ascii=False))
assert all(x['passed'] for x in results),report
