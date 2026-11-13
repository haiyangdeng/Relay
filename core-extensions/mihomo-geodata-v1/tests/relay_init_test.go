package geodata

import (
	"bytes"
	"github.com/metacubex/mihomo/component/geodata/router"
	"github.com/metacubex/mihomo/component/mmdb"
	C "github.com/metacubex/mihomo/constant"
	"google.golang.org/protobuf/proto"
	"os"
	"path/filepath"
	"testing"
)

func controlledHome(t *testing.T) string {
	t.Helper()
	if !mmdb.RelayControlled() {
		t.Skip("controlled only")
	}
	home, e := filepath.EvalSymlinks(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	if e = os.Chmod(home, 0700); e != nil {
		t.Fatal(e)
	}
	C.SetHomeDir(home)
	SetLoader("standard")
	ClearGeoSiteCache()
	ClearGeoIPCache()
	initGeoSite = false
	initGeoIP = 0
	initASN = false
	return home
}
func TestControlledInitializationPreservesInvalid(t *testing.T) {
	for _, kind := range []string{"site", "ip", "asn"} {
		t.Run(kind, func(t *testing.T) {
			home := controlledHome(t)
			name, call := "GeoSite.dat", InitGeoSite
			switch kind {
			case "ip":
				SetGeodataMode(true)
				name = "GeoIP.dat"
				call = InitGeoIP
			case "asn":
				name = "ASN.mmdb"
				call = InitASN
			}
			path := filepath.Join(home, name)
			if e := call(); e == nil {
				t.Fatal("missing controlled asset accepted")
			}
			if _, e := os.Lstat(path); !os.IsNotExist(e) {
				t.Fatal("missing file materialized", e)
			}
			original := []byte("INVALID-KEEP-ORIGINAL")
			if e := os.WriteFile(path, original, 0600); e != nil {
				t.Fatal(e)
			}
			if e := call(); e == nil {
				t.Fatal("invalid controlled asset accepted")
			}
			after, e := os.ReadFile(path)
			if e != nil || !bytes.Equal(after, original) {
				t.Fatal("invalid original deleted/changed", e)
			}
			if e = os.Rename(path, path+".saved"); e != nil {
				t.Fatal(e)
			}
			if e = os.Symlink(path+".saved", path); e != nil {
				t.Fatal(e)
			}
			if e = call(); e == nil {
				t.Fatal("controlled symlink accepted")
			}
			st, e := os.Lstat(path)
			if e != nil || st.Mode()&os.ModeSymlink == 0 {
				t.Fatal("symlink not preserved", e)
			}
		})
	}
}
func TestControlledInitializationCustomTags(t *testing.T) {
	home := controlledHome(t)
	site, e := proto.Marshal(&router.GeoSiteList{Entry: []*router.GeoSite{{CountryCode: "CUSTOM", Domain: []*router.Domain{{Type: router.Domain_Full, Value: "fixture.invalid"}}}}})
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(home, "GeoSite.dat"), site, 0600); e != nil {
		t.Fatal(e)
	}
	if e = InitGeoSite(); e != nil {
		t.Fatal("forced CN on valid custom GeoSite", e)
	}
	ip, e := proto.Marshal(&router.GeoIPList{Entry: []*router.GeoIP{{CountryCode: "CUSTOM", Cidr: []*router.CIDR{{Ip: []byte{127, 0, 0, 0}, Prefix: 8}}}}})
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(home, "GeoIP.dat"), ip, 0600); e != nil {
		t.Fatal(e)
	}
	SetGeodataMode(true)
	if e = InitGeoIP(); e != nil {
		t.Fatal("forced CN on valid custom GeoIP", e)
	}
}
