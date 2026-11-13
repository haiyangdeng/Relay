package mmdb

import (
	"bytes"
	C "github.com/metacubex/mihomo/constant"
	"github.com/oschwald/maxminddb-golang"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, e := os.ReadFile(os.Getenv("RELAY_GEO_FIXTURES") + "/" + name)
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func changed(t *testing.T, source, old, next []byte) []byte {
	t.Helper()
	if len(old) != len(next) || bytes.Count(source, old) != 1 {
		t.Fatal("fixture replacement must be one exact equal-length data value")
	}
	return bytes.Replace(source, old, next, 1)
}
func TestCountryImmutableGeneration(t *testing.T) {
	if !RelayControlled() {
		t.Skip("controlled-mode only")
	}
	old := fixture(t, "GeoIP2-Country-Test.mmdb")
	next := changed(t, old, []byte{0x42, 'G', 'B'}, []byte{0x42, 'Z', 'Z'})
	a, e := PrepareIP(old)
	if e != nil {
		t.Fatal(e)
	}
	b, e := PrepareIP(next)
	if e != nil {
		t.Fatal(e)
	}
	PublishIP(a)
	captured := IPInstance()
	ip := net.ParseIP("81.2.69.142")
	if got := captured.LookupCode(ip); len(got) != 1 || got[0] != "gb" {
		t.Fatal(got)
	}
	PublishIP(b)
	runtime.GC()
	if got := IPInstance().LookupCode(ip); len(got) != 1 || got[0] != "zz" {
		t.Fatal(got)
	}
	if got := captured.LookupCode(ip); len(got) != 1 || got[0] != "gb" {
		t.Fatal("old captured immutable reader changed", got)
	}
	// Caller mutation after prepare cannot change published bytes.
	for i := range next {
		next[i] = 0
	}
	if got := IPInstance().LookupCode(ip); len(got) != 1 || got[0] != "zz" {
		t.Fatal(got)
	}
	if _, e = PrepareIP([]byte("invalid")); e == nil {
		t.Fatal("invalid candidate accepted")
	}
	if got := IPInstance().LookupCode(ip); len(got) != 1 || got[0] != "zz" {
		t.Fatal("failed candidate damaged old head", got)
	}
}
func TestASNConcurrentGeneration(t *testing.T) {
	if !RelayControlled() {
		t.Skip("controlled-mode only")
	}
	old := fixture(t, "GeoLite2-ASN-Test.mmdb")
	next := changed(t, old, []byte{0xc2, 0x3b, 0x41}, []byte{0xc2, 0x3b, 0x42})
	a, e := PrepareASN(old)
	if e != nil {
		t.Fatal(e)
	}
	b, e := PrepareASN(next)
	if e != nil {
		t.Fatal(e)
	}
	PublishASN(a)
	captured := ASNInstance()
	ip := net.ParseIP("1.0.0.1")
	if got, _ := captured.LookupASN(ip); got != "15169" {
		t.Fatal(got)
	}
	var wait sync.WaitGroup
	for n := 0; n < 8; n++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for i := 0; i < 2000; i++ {
				got, _ := ASNInstance().LookupASN(ip)
				if got != "15169" && got != "15170" {
					t.Error("mixed/closed reader", got)
					return
				}
				got, _ = captured.LookupASN(ip)
				if got != "15169" {
					t.Error("old generation modified", got)
					return
				}
			}
		}()
	}
	for n := 0; n < 100; n++ {
		PublishASN(b)
		runtime.GC()
		PublishASN(a)
	}
	wait.Wait()
	PublishASN(b)
	if got, _ := ASNInstance().LookupASN(ip); got != "15170" {
		t.Fatal(got)
	}
	if _, e = PrepareASN(fixture(t, "GeoIP2-Country-Test.mmdb")); e == nil {
		t.Fatal("country kind admitted as ASN")
	}
	if got, _ := ASNInstance().LookupASN(ip); got != "15170" {
		t.Fatal("failure replaced head", got)
	}
}

func TestNonControlledKeepsUpstream(t *testing.T) {
	if RelayControlled() {
		t.Skip("non-controlled-mode only")
	}
	old := fixture(t, "GeoIP2-Country-Test.mmdb")
	home := t.TempDir()
	C.SetHomeDir(home)
	if e := os.WriteFile(filepath.Join(home, "Country.mmdb"), old, 0600); e != nil {
		t.Fatal(e)
	}
	LoadFromBytes(old)
	ip := net.ParseIP("81.2.69.142")
	if got := IPInstance().LookupCode(ip); len(got) != 1 || got[0] != "gb" {
		t.Fatal(got)
	}
	if e := IPInstance().Reader.Close(); e != nil {
		t.Fatal(e)
	}
	ReloadIP() // original sync.Once reset reopens the actual private fixture.
	if got := IPInstance().LookupCode(ip); len(got) != 1 || got[0] != "gb" {
		t.Fatal(got)
	}
	if !Verify(filepath.Join(home, "Country.mmdb")) {
		t.Fatal("original verifier changed")
	}
}

func TestASNMissingIPInfoRecordDoesNotPanic(t *testing.T) {
	reader, err := maxminddb.FromBytes(fixture(t, "GeoIP2-Country-Test.mmdb"))
	if err != nil {
		t.Fatal(err)
	}
	reader.Metadata.DatabaseType = "ipinfo generic_asn_free.mmdb"
	value := ASNReader{Reader: reader}
	asn, _ := value.LookupASN(net.ParseIP("81.2.69.142"))
	if asn != "" {
		t.Fatal(asn)
	}
}
