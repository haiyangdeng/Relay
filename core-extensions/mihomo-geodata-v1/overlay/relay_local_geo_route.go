//go:build darwin && relay_local_geodata

package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"strconv"
	"unicode/utf8"

	"github.com/metacubex/chi"
	http "github.com/metacubex/http"
	"github.com/metacubex/mihomo/component/mmdb"
	"github.com/metacubex/mihomo/component/updater"
	"github.com/metacubex/mihomo/hub/route"
)

func relayGeoJSON(r *http.Request) (map[string]any, error) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 4097))
	if err != nil || len(raw) == 0 || len(raw) > 4096 || !utf8.Valid(raw) {
		return nil, updater.ErrRelayLocalGeo
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return nil, updater.ErrRelayLocalGeo
	}
	v := map[string]any{}
	for d.More() {
		key, err := d.Token()
		name, ok := key.(string)
		if err != nil || !ok || len(name) > 64 {
			return nil, updater.ErrRelayLocalGeo
		}
		if _, exists := v[name]; exists {
			return nil, updater.ErrRelayLocalGeo
		}
		value, err := d.Token()
		if err != nil {
			return nil, updater.ErrRelayLocalGeo
		}
		switch value := value.(type) {
		case string:
			if len(value) > 256 {
				return nil, updater.ErrRelayLocalGeo
			}
			v[name] = value
		case json.Number:
			v[name] = value
		default:
			return nil, updater.ErrRelayLocalGeo
		}
		if len(v) > 9 {
			return nil, updater.ErrRelayLocalGeo
		}
	}
	if token, err = d.Token(); err != nil || token != json.Delim('}') {
		return nil, updater.ErrRelayLocalGeo
	}
	if _, err = d.Token(); err != io.EOF {
		return nil, updater.ErrRelayLocalGeo
	}
	return v, nil
}
func relayGeoNonce(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, c := range value {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func relayGeoHTTP(w http.ResponseWriter, r *http.Request) {
	addr, ok := r.Context().Value(http.LocalAddrContextKey).(net.Addr)
	if !ok || addr.Network() != "unix" || r.Method != "POST" {
		http.NotFound(w, r)
		return
	}
	v, err := relayGeoJSON(r)
	if err != nil {
		http.Error(w, "invalid local geodata request", 400)
		return
	}
	version, ok := v["version"].(json.Number)
	if !ok || string(version) != "1" {
		http.Error(w, "unsupported local geodata version", 400)
		return
	}
	action, ok := v["action"].(string)
	if !ok {
		http.Error(w, "invalid local geodata action", 400)
		return
	}
	receipt := updater.RelayGeoReceipt{Version: 1}
	switch action {
	case "state":
		if len(v) != 2 {
			http.Error(w, "invalid state selection", 400)
			return
		}
		receipt, err = updater.RelayLocalGeoState(r.Context())
	case "prepare":
		if len(v) != 8 && len(v) != 9 {
			http.Error(w, "invalid prepare selection", 400)
			return
		}
		for key := range v {
			switch key {
			case "version", "action", "kind", "oldSHA256", "newSHA256", "expectedGenerationSHA256", "blobId", "selector", "leaseMS":
			default:
				http.Error(w, "unknown prepare field", 400)
				return
			}
		}
		stringValue := func(key string) string { s, _ := v[key].(string); return s }
		var lease int64
		if value, present := v["leaseMS"]; present {
			number, ok := value.(json.Number)
			if !ok {
				http.Error(w, "invalid lease", 400)
				return
			}
			lease, err = strconv.ParseInt(string(number), 10, 64)
			if err != nil {
				http.Error(w, "invalid lease", 400)
				return
			}
		}
		receipt, err = updater.PrepareRelayLocalGeo(r.Context(), updater.RelayGeoPrepare{Kind: stringValue("kind"), OldSHA256: stringValue("oldSHA256"), NewSHA256: stringValue("newSHA256"), ExpectedGenerationSHA256: stringValue("expectedGenerationSHA256"), BlobID: stringValue("blobId"), Selector: stringValue("selector"), LeaseMS: lease})
	case "commit", "cancel":
		nonce, ok := v["nonce"].(string)
		if len(v) != 3 || !ok || !relayGeoNonce(nonce) {
			http.Error(w, "invalid nonce selection", 400)
			return
		}
		if action == "commit" {
			receipt, err = updater.CommitRelayLocalGeo(r.Context(), nonce)
		} else {
			receipt = updater.CancelRelayLocalGeo(nonce)
		}
	default:
		http.Error(w, "unsupported local geodata action", 400)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if err == nil && action == "state" {
		resources := receipt.Resources
		if resources == nil {
			resources = []updater.RelayGeoResource{}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"version": 1, "capability": receipt.Capability, "bootId": receipt.BootID, "sequence": receipt.Sequence, "generationSHA256": receipt.GenerationSHA256, "resources": resources})
		return
	}
	if err != nil {
		if receipt.Status == "" {
			receipt.Status = "stale"
		}
		w.WriteHeader(409)
	}
	if receipt.Status != "prepared" && receipt.Status != "applied" {
		_ = json.NewEncoder(w).Encode(map[string]any{"version": 1, "status": receipt.Status})
		return
	}
	if encodeErr := json.NewEncoder(w).Encode(receipt); encodeErr != nil && receipt.Status == "prepared" {
		updater.CancelRelayLocalGeo(receipt.Nonce)
	}
}
func init() {
	if !mmdb.RelayControlled() {
		return
	}
	route.Register(func(r chi.Router) { r.Post("/relay/geodata/v1", relayGeoHTTP) })
}
