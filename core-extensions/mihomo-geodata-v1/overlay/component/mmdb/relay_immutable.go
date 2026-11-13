package mmdb

import (
	"bytes"
	"fmt"
	"golang.org/x/sys/unix"
	"io"
	"os"
	"path/filepath"
	"sync"

	C "github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/log"
	"github.com/oschwald/maxminddb-golang"
)

// Controlled generations own immutable heap bytes. Do not Close a published
// Reader: maxminddb v1.12 Close mutates its buffer and races with Lookup.
// Old value copies retain their Reader/bytes until ordinary Go GC.
var relayImmutableReaders = os.Getenv("RELAY_LOCAL_GEODATA_V1") == "1"

func RelayControlled() bool { return relayImmutableReaders }

var readerHeads struct {
	sync.Mutex
	ip  IPReader
	asn ASNReader
}

type PreparedIP struct{ reader IPReader }
type PreparedASN struct{ reader ASNReader }

func PrepareIP(buffer []byte) (*PreparedIP, error) {
	reader, err := maxminddb.FromBytes(bytes.Clone(buffer))
	if err != nil {
		return nil, err
	}
	if err = reader.Verify(); err != nil {
		return nil, err
	}
	kind := typeMaxmind
	switch reader.Metadata.DatabaseType {
	case "sing-geoip":
		kind = typeSing
	case "Meta-geoip0":
		kind = typeMetaV0
	case "GeoLite2-ASN", "DBIP-ASN-Lite (compat=GeoLite2-ASN)", "ipinfo generic_asn_free.mmdb":
		return nil, fmt.Errorf("ASN database cannot be a country database")
	default: // Preserve upstream MaxMind-map country lookup compatibility.

	}
	return &PreparedIP{IPReader{Reader: reader, databaseType: kind}}, nil
}
func PrepareASN(buffer []byte) (*PreparedASN, error) {
	reader, err := maxminddb.FromBytes(bytes.Clone(buffer))
	if err != nil {
		return nil, err
	}
	if err = reader.Verify(); err != nil {
		return nil, err
	}
	switch reader.Metadata.DatabaseType {
	case "GeoLite2-ASN", "DBIP-ASN-Lite (compat=GeoLite2-ASN)", "ipinfo generic_asn_free.mmdb":
	default:
		return nil, fmt.Errorf("unsupported ASN database type")
	}
	return &PreparedASN{ASNReader{Reader: reader}}, nil
}

// Candidates are fully parsed before publication, so this operation cannot
// fail after replacing the old generation. No old Reader is closed/unmapped.
func PublishIP(next *PreparedIP) {
	if next == nil || next.reader.Reader == nil {
		panic("invalid prepared country reader")
	}
	readerHeads.Lock()
	readerHeads.ip = next.reader
	readerHeads.Unlock()
}
func PublishASN(next *PreparedASN) {
	if next == nil || next.reader.Reader == nil {
		panic("invalid prepared ASN reader")
	}
	readerHeads.Lock()
	readerHeads.asn = next.reader
	readerHeads.Unlock()
}
func relayLoadFromBytes(buffer []byte) {
	readerHeads.Lock()
	defer readerHeads.Unlock()
	if readerHeads.ip.Reader != nil {
		return
	}
	next, err := PrepareIP(buffer)
	if err != nil {
		log.Fatalln("Can't load mmdb: %s", err.Error())
		return
	}
	readerHeads.ip = next.reader
}

func relayIPInstance() IPReader {
	readerHeads.Lock()
	defer readerHeads.Unlock()
	if readerHeads.ip.Reader == nil {
		buffer, err := ReadControlledAsset("country-mmdb")
		if err != nil {
			log.Fatalln("Can't read MMDB: %s", err.Error())
			return IPReader{}
		}
		next, err := PrepareIP(buffer)
		if err != nil {
			log.Fatalln("Can't load MMDB: %s", err.Error())
			return IPReader{}
		}
		readerHeads.ip = next.reader
	}
	return readerHeads.ip
}
func relayASNInstance() ASNReader {
	readerHeads.Lock()
	defer readerHeads.Unlock()
	if readerHeads.asn.Reader == nil {
		buffer, err := ReadControlledAsset("asn-mmdb")
		if err != nil {
			log.Fatalln("Can't read ASN: %s", err.Error())
			return ASNReader{}
		}
		next, err := PrepareASN(buffer)
		if err != nil {
			log.Fatalln("Can't load ASN: %s", err.Error())
			return ASNReader{}
		}
		readerHeads.asn = next.reader
	}
	return readerHeads.asn
}
func relayReloadIP()  { readerHeads.Lock(); readerHeads.ip = IPReader{}; readerHeads.Unlock() }
func relayReloadASN() { readerHeads.Lock(); readerHeads.asn = ASNReader{}; readerHeads.Unlock() }

// Read only one fixed controlled asset. This must also protect initialization:
// a privileged Core must never follow a replaced user-owned Geo symlink.
func sameControlledAsset(a, b unix.Stat_t) bool {
	return a.Dev == b.Dev && a.Ino == b.Ino && a.Mode == b.Mode && a.Uid == b.Uid && a.Gid == b.Gid && a.Nlink == b.Nlink && a.Size == b.Size && a.Mtim == b.Mtim && a.Ctim == b.Ctim
}
func ReadControlledAsset(kind string) ([]byte, error) {
	names := map[string]string{"geoip-dat": "GeoIP.dat", "geosite-dat": "GeoSite.dat", "country-mmdb": "Country.mmdb", "asn-mmdb": "ASN.mmdb"}
	name := names[kind]
	home := C.Path.HomeDir()
	if !relayImmutableReaders || name == "" || !filepath.IsAbs(home) {
		return nil, fmt.Errorf("controlled asset unavailable")
	}
	physical, err := filepath.EvalSymlinks(home)
	if err != nil || physical != home {
		return nil, fmt.Errorf("controlled asset root changed")
	}
	dir, err := unix.Open(home, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	defer unix.Close(dir)
	var root, linkedRoot, before, after, linked unix.Stat_t
	if unix.Fstat(dir, &root) != nil || root.Uid == 0 || (root.Uid != uint32(os.Getuid()) && os.Geteuid() != 0) || root.Mode&07777 != 0700 {
		return nil, fmt.Errorf("controlled asset root unverified")
	}
	fd, err := unix.Openat(dir, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), name)
	defer f.Close()
	if unix.Fstat(fd, &before) != nil || before.Mode&unix.S_IFMT != unix.S_IFREG || before.Mode&07777 != 0600 || before.Uid != root.Uid || before.Gid != root.Gid || before.Nlink != 1 || before.Size <= 0 || before.Size > 128*1024*1024 {
		return nil, fmt.Errorf("controlled asset identity unverified")
	}
	data, err := io.ReadAll(io.LimitReader(f, 128*1024*1024+1))
	if err != nil || int64(len(data)) != before.Size || unix.Fstat(fd, &after) != nil || unix.Fstatat(dir, name, &linked, unix.AT_SYMLINK_NOFOLLOW) != nil || !sameControlledAsset(before, after) || !sameControlledAsset(after, linked) || unix.Lstat(home, &linkedRoot) != nil || root.Dev != linkedRoot.Dev || root.Ino != linkedRoot.Ino || root.Uid != linkedRoot.Uid || root.Gid != linkedRoot.Gid || root.Mode != linkedRoot.Mode {
		return nil, fmt.Errorf("controlled asset changed")
	}
	return data, nil
}
