package updater

import (
	"bytes"
	"context"
	"errors"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/metacubex/mihomo/component/geodata"
	C "github.com/metacubex/mihomo/constant"
)

func TestControlledUpdaterEntrypoints(t *testing.T) {
	if !relayLocalGeoControlled {
		if e := UpdateGeoDatabases(); e != nil {
			t.Fatal(e)
		}
		return
	}
	for _, call := range []func() error{UpdateMMDB, UpdateASN, UpdateGeoIp, UpdateGeoSite, UpdateGeoDatabases} {
		err := call()
		if relayLocalGeoControlled {
			if !errors.Is(err, ErrRelayLocalGeoNetworkDisabled) {
				t.Fatal("network updater not rejected", err)
			}
		}
	}
}
func geoHome(t *testing.T) (string, []byte, []byte) {
	t.Helper()
	if !relayLocalGeoControlled {
		t.Skip("controlled only")
	}
	relayGeoState.Lock()
	if relayGeoState.ticket != nil {
		relayGeoState.ticket.close()
	}
	relayGeoState.ticket = nil
	relayGeoState.resources = nil
	relayGeoState.bootID = ""
	relayGeoState.head = ""
	relayGeoState.sequence = 0
	relayGeoState.uncertain = false
	relayGeoState.Unlock()
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(home, 0700); err != nil {
		t.Fatal(err)
	}
	C.SetHomeDir(home)
	geodata.SetLoader("standard")
	geodata.ClearGeoSiteCache()
	old, err := os.ReadFile(os.Getenv("RELAY_GEO_DAT_FIXTURE"))
	if err != nil {
		t.Fatal(err)
	}
	next := bytes.ReplaceAll(old, []byte("fixture.invalid"), []byte("changed.invalid"))
	if bytes.Equal(old, next) {
		t.Fatal("expected established synthetic fixture")
	}
	if err = os.WriteFile(filepath.Join(home, "GeoSite.dat"), old, 0600); err != nil {
		t.Fatal(err)
	}
	if err = geodata.InitGeoSite(); err != nil {
		t.Fatal(err)
	}
	return home, old, next
}
func geoSelection(t *testing.T, home string, old, next []byte) RelayGeoPrepare {
	t.Helper()
	blob, err := relayNewUUID()
	if err != nil {
		t.Fatal(err)
	}
	stage := filepath.Join(home, "RelayGeoInbox", blob)
	if err = os.MkdirAll(stage, 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(stage, "GeoSite.dat"), next, 0600); err != nil {
		t.Fatal(err)
	}
	state, err := RelayLocalGeoState(context.Background())
	if err != nil {
		d, _ := os.Stat(home)
		f, _ := os.Stat(filepath.Join(home, "GeoSite.dat"))
		t.Fatalf("state: %v home=%s dir=%#v file=%#v", err, home, d.Sys(), f.Sys())
	}
	return RelayGeoPrepare{Kind: "geosite-dat", OldSHA256: relayGeoHash(old), NewSHA256: relayGeoHash(next), ExpectedGenerationSHA256: state.GenerationSHA256, BlobID: blob, Selector: "RELAY"}
}
func unchangedGeo(t *testing.T, home string, old []byte) {
	t.Helper()
	b, e := os.ReadFile(filepath.Join(home, "GeoSite.dat"))
	if e != nil || !bytes.Equal(b, old) {
		t.Fatal("known original changed", e)
	}
}
func TestLocalGeoNonceAndState(t *testing.T) {
	home, old, next := geoHome(t)
	input := geoSelection(t, home, old, next)
	state, e := RelayLocalGeoState(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	if len(state.Resources) != 1 || state.Resources[0].Kind != "geosite-dat" || state.Sequence != 0 {
		t.Fatal(state)
	}
	p, e := PrepareRelayLocalGeo(context.Background(), input)
	if e != nil {
		t.Fatal(e)
	}
	unchangedGeo(t, home, old)
	relayGeoState.Lock()
	retired := relayGeoState.ticket
	relayGeoState.Unlock()
	if CancelRelayLocalGeo(p.Nonce).Status != "cancelled" {
		t.Fatal("cancel failed")
	}
	if retired.data != nil || retired.ip != nil || retired.asn != nil {
		t.Fatal("cancelled payload retained by lease timer")
	}
	if _, e = CommitRelayLocalGeo(context.Background(), p.Nonce); e == nil {
		t.Fatal("cancelled nonce replay")
	}
	unchangedGeo(t, home, old)
	p, e = PrepareRelayLocalGeo(context.Background(), input)
	if e != nil {
		t.Fatal(e)
	}
	r, e := CommitRelayLocalGeo(context.Background(), p.Nonce)
	if e != nil || r.Status != "applied" || r.Sequence != 1 || r.PreviousGenerationSHA256 != state.GenerationSHA256 || r.GenerationSHA256 == state.GenerationSHA256 {
		t.Fatal(r, e)
	}
	retained, e := os.ReadFile(filepath.Join(home, "RelayGeo.retained-"+p.Nonce))
	if e != nil || !bytes.Equal(retained, old) {
		t.Fatal("old bytes not retained", e)
	}
	if _, e = CommitRelayLocalGeo(context.Background(), p.Nonce); e == nil {
		t.Fatal("successful nonce replay")
	}
}
func TestLocalGeoUnsafeStageAndCancellation(t *testing.T) {
	for _, kind := range []string{"symlink", "hardlink", "invalid-data", "oversize", "directory-replacement", "deadline", "foreign-publication"} {
		t.Run(kind, func(t *testing.T) {
			home, old, next := geoHome(t)
			input := geoSelection(t, home, old, next)
			stage := filepath.Join(home, "RelayGeoInbox", input.BlobID, "GeoSite.dat")
			if kind == "symlink" {
				if e := os.Remove(stage); e != nil {
					t.Fatal(e)
				}
				if e := os.Symlink(filepath.Join(home, "GeoSite.dat"), stage); e != nil {
					t.Fatal(e)
				}
			}
			if kind == "hardlink" {
				if e := os.Link(stage, stage+".alias"); e != nil {
					t.Fatal(e)
				}
			}
			if kind == "invalid-data" {
				data := []byte("INVALID-PRESERVE")
				if e := os.WriteFile(stage, data, 0600); e != nil {
					t.Fatal(e)
				}
				input.NewSHA256 = relayGeoHash(data)
			}
			if kind == "oversize" {
				f, e := os.OpenFile(stage, os.O_WRONLY, 0600)
				if e != nil {
					t.Fatal(e)
				}
				e = f.Truncate(relayGeoLimit + 1)
				_ = f.Close()
				if e != nil {
					t.Fatal(e)
				}
			}
			p, e := PrepareRelayLocalGeo(context.Background(), input)
			if kind == "symlink" || kind == "hardlink" || kind == "invalid-data" || kind == "oversize" {
				if e == nil {
					t.Fatal("unsafe stage admitted")
				}
				unchangedGeo(t, home, old)
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			switch kind {
			case "directory-replacement":
				inbox := filepath.Join(home, "RelayGeoInbox")
				if e = os.Rename(inbox, inbox+".saved"); e != nil {
					t.Fatal(e)
				}
				if e = os.Mkdir(inbox, 0700); e != nil {
					t.Fatal(e)
				}
			case "deadline":
				relayGeoState.Lock()
				relayGeoState.ticket.deadline = time.Now().Add(-time.Second)
				relayGeoState.Unlock()
			case "foreign-publication":
				if e = os.WriteFile(filepath.Join(home, "RelayGeo.retained-"+p.Nonce), []byte("FOREIGN"), 0600); e != nil {
					t.Fatal(e)
				}
			}
			r, e := CommitRelayLocalGeo(context.Background(), p.Nonce)
			if e == nil {
				t.Fatal("unsafe commit admitted")
			}
			unchangedGeo(t, home, old)
			if kind == "foreign-publication" {
				b, e := os.ReadFile(filepath.Join(home, "RelayGeo.retained-"+p.Nonce))
				if e != nil || string(b) != "FOREIGN" || r.Status != "uncertain" {
					t.Fatal(r, e)
				}
				if _, e = PrepareRelayLocalGeo(context.Background(), input); e == nil {
					t.Fatal("unknown write permitted retry")
				}
			}
		})
	}
}
func TestLocalGeoSelectorAndMissingKinds(t *testing.T) {
	home, old, next := geoHome(t)
	input := geoSelection(t, home, old, next)
	for _, selector := range []string{"", " RELAY", "RELAY,REJECT", "RELAY\x00", "MISSING"} {
		v := input
		v.Selector = selector
		if _, e := PrepareRelayLocalGeo(context.Background(), v); e == nil {
			t.Fatal("invalid selector accepted", selector)
		}
	}
	v := input
	v.Kind = "geoip-dat"
	if _, e := PrepareRelayLocalGeo(context.Background(), v); e == nil {
		t.Fatal("missing kind adopted")
	}
	unchangedGeo(t, home, old)
	if relayGeoSelector(string(bytes.Repeat([]byte{'a'}, 257))) {
		t.Fatal("oversize selector accepted")
	}
}
func TestLocalGeoForeignOtherKind(t *testing.T) {
	home, old, next := geoHome(t)
	input := geoSelection(t, home, old, next)
	if e := os.WriteFile(filepath.Join(home, "Country.mmdb"), []byte("FOREIGN"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e := PrepareRelayLocalGeo(context.Background(), input); e == nil {
		t.Fatal("new unknown resource silently adopted")
	}
	unchangedGeo(t, home, old)
}

func TestLocalGeoAggregateBudget(t *testing.T) {
	rows := []RelayGeoResource{{Kind: "geosite-dat", Bytes: 128 * 1024 * 1024}, {Kind: "country-mmdb", Bytes: 128 * 1024 * 1024}}
	if !relayGeoTotal(rows, "", 0) || !relayGeoTotal(rows, "country-mmdb", 128*1024*1024) {
		t.Fatal("exact aggregate or replacement double-counted")
	}
	rows = append(rows, RelayGeoResource{Kind: "asn-mmdb", Bytes: 1})
	if relayGeoTotal(rows, "", 0) {
		t.Fatal("aggregate overflow accepted")
	}
	if relayGeoTotal(rows, "country-mmdb", 128*1024*1024) {
		t.Fatal("replacement aggregate overflow accepted")
	}
}

func TestLocalGeoPrivateModeIgnoresInheritedUmask(t *testing.T) {
	home, old, next := geoHome(t)
	input := geoSelection(t, home, old, next)
	p, e := PrepareRelayLocalGeo(context.Background(), input)
	if e != nil {
		t.Fatal(e)
	}
	mask := unix.Umask(0777)
	defer unix.Umask(mask)
	r, e := CommitRelayLocalGeo(context.Background(), p.Nonce)
	if e != nil || r.Status != "applied" {
		t.Fatal(r, e)
	}
	st, e := os.Stat(filepath.Join(home, "GeoSite.dat"))
	if e != nil || st.Mode().Perm() != 0600 {
		t.Fatal("published mode depends on umask", e)
	}
}
