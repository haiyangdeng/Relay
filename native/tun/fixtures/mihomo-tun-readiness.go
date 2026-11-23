package main

// Parse and serialize the pinned upstream API contract. This process never
// calls ApplyConfig, ReCreateTun, sing_tun.New, or any listener/device startup.
import (
	"encoding/json"
	"github.com/metacubex/mihomo/config"
	C "github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/hub/executor"
	"github.com/metacubex/mihomo/listener"
	"github.com/metacubex/mihomo/log"
	tun "github.com/metacubex/sing-tun"
	"os"
	"runtime"
)

func must(err error) {
	if err != nil {
		panic(err)
	}
}
func main() {
	if runtime.GOOS != "darwin" || os.Geteuid() == 0 {
		panic("Darwin ordinary UID required")
	}
	temp, err := os.MkdirTemp("", "relay-dns-contract-")
	must(err)
	defer os.RemoveAll(temp)
	C.SetHomeDir(temp)
	log.SetLevel(log.ERROR)
	rows := []any{}
	for _, name := range []string{"omitted", "empty", "disabled", "native", "hijack"} {
		source := map[string]any{
			"port": 0, "socks-port": 0, "mixed-port": 0, "redir-port": 0, "tproxy-port": 0,
			"mode": "rule", "allow-lan": false, "ipv6": false,
			"dns": map[string]any{"enable": false}, "rules": []string{"MATCH,DIRECT"},
			"tun": map[string]any{"enable": true, "device": "utun42", "stack": "mixed", "mtu": 1500, "auto-route": true, "auto-detect-interface": true, "dns-hijack": []string{"any:53"}, "recvmsgx": false, "sendmsgx": false, "auto-redirect": false, "gso": false},
		}
		if name != "omitted" {
			value := name
			if name == "empty" {
				value = ""
			}
			source["tun"].(map[string]any)["dns-mode"] = value
		}
		data, err := json.Marshal(source)
		must(err)
		parsed, err := config.Parse(data)
		must(err)
		listener.LastTunConf = parsed.General.Tun
		// getConfigs uses GetGeneral. Without a started listener GetTunConf returns
		// LastTunConf; a started listener's Config returns the same unmutated options.
		apiTun := executor.GetGeneral().Tun
		options := tun.Options{DNSMode: apiTun.DNSMode, AutoRoute: apiTun.AutoRoute}
		rows = append(rows, map[string]any{"name": name, "source": source, "apiTun": apiTun, "darwinEffectiveDNSMode": options.DNSModeOrDefault()})
	}
	output := map[string]any{"upstreamCommit": "3f27ef39f8c96bbfbc8b0b9bb10f5c9ef60149d8", "singTunVersion": "v0.4.28", "provenance": "config.Parse -> listener.LastTunConf -> executor.GetGeneral().Tun -> encoding/json; no ApplyConfig, listener or device creation", "cases": rows}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	must(encoder.Encode(output))
}
