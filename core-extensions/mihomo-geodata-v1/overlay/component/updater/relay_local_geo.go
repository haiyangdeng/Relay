//go:build darwin && relay_local_geodata

package updater

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/metacubex/mihomo/component/geodata"
	"github.com/metacubex/mihomo/component/mmdb"
	C "github.com/metacubex/mihomo/constant"
	"golang.org/x/sys/unix"
)

const relayGeoLimit = 128 * 1024 * 1024
const relayGeoTotalLimit int64 = 256 * 1024 * 1024
const relayGeoMaximumSequence uint64 = 9_007_199_254_740_991

var relayLocalGeoControlled = mmdb.RelayControlled()
var ErrRelayLocalGeo = errors.New("local geodata selection not verified")
var ErrRelayLocalGeoNetworkDisabled = errors.New("network geodata updater disabled in controlled local mode")
var relayKinds = []string{"geoip-dat", "geosite-dat", "country-mmdb", "asn-mmdb"}
var relayNames = map[string]string{"geoip-dat": "GeoIP.dat", "geosite-dat": "GeoSite.dat", "country-mmdb": "Country.mmdb", "asn-mmdb": "ASN.mmdb"}

type RelayGeoResource struct {
	Kind   string `json:"kind"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
	Active bool   `json:"active"`
}
type RelayGeoReceipt struct {
	Version                  int                `json:"version"`
	Status                   string             `json:"status,omitempty"`
	Capability               string             `json:"capability,omitempty"`
	BootID                   string             `json:"bootId,omitempty"`
	Kind                     string             `json:"kind,omitempty"`
	Nonce                    string             `json:"nonce,omitempty"`
	OldSHA256                string             `json:"oldSHA256,omitempty"`
	NewSHA256                string             `json:"newSHA256,omitempty"`
	Bytes                    int64              `json:"bytes,omitempty"`
	Sequence                 uint64             `json:"sequence"`
	PreviousGenerationSHA256 string             `json:"previousGenerationSHA256,omitempty"`
	GenerationSHA256         string             `json:"generationSHA256,omitempty"`
	RemainingMS              int64              `json:"remainingMS,omitempty"`
	Retained                 bool               `json:"retainedOriginal,omitempty"`
	Resources                []RelayGeoResource `json:"resources,omitempty"`
}
type RelayGeoPrepare struct {
	Kind, OldSHA256, NewSHA256, ExpectedGenerationSHA256, BlobID, Selector string
	LeaseMS                                                                int64
}
type relayGeoTicket struct {
	dir, stage, inbox                                *os.File
	stageRoot, inboxRoot                             unix.Stat_t
	home, nonce, old, next, kind, name, head, blobID string
	root, previous, staged                           unix.Stat_t
	data                                             []byte
	deadline                                         time.Time
	sequence                                         uint64
	ip                                               *mmdb.PreparedIP
	asn                                              *mmdb.PreparedASN
	cancelled, entered                               atomic.Bool
	committing                                       bool
}

var relayGeoState struct {
	sync.Mutex
	bootID, head string
	sequence     uint64
	resources    []RelayGeoResource
	ticket       *relayGeoTicket
	uncertain    bool
	initializing bool
	preparing    bool
}

func relayGeoHash(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
func relayGeoSHA(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func relayGeoUUID(s string) bool {
	if len(s) != 36 || s[8] != '-' || s[13] != '-' || s[18] != '-' || s[23] != '-' {
		return false
	}
	for i, c := range s {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			continue
		}
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func relayNewUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}
func relayGeoSame(a, b unix.Stat_t) bool {
	return a.Dev == b.Dev && a.Ino == b.Ino && a.Uid == b.Uid && a.Gid == b.Gid && a.Mode == b.Mode && a.Nlink == b.Nlink && a.Size == b.Size && a.Mtim == b.Mtim && a.Ctim == b.Ctim
}

// Eligibility is fixed by the controlled existing file set and geodata mode,
// not by lazy reader/cache counters. Ordinary traffic cannot gain authority.
func relayGeoActive(kind string) bool {
	switch kind {
	case "geosite-dat", "asn-mmdb":
		return true
	case "geoip-dat":
		return geodata.GeodataMode()
	case "country-mmdb":
		return !geodata.GeodataMode()
	}
	return false
}
func relayGeoTotal(resources []RelayGeoResource, replacement string, next int64) bool {
	total := int64(0)
	found := replacement == ""
	for _, r := range resources {
		size := r.Bytes
		if r.Kind == replacement {
			size = next
			found = true
		}
		if size <= 0 || size > relayGeoLimit {
			return false
		}
		total += size
		if total > relayGeoTotalLimit {
			return false
		}
	}
	return found
}
func relayGeoHead(boot string, seq uint64, resources []RelayGeoResource) string {
	value := "relay.local.geodata.v1\n" + boot + "\n" + strconv.FormatUint(seq, 10) + "\n"
	for _, kind := range relayKinds {
		value += kind + ":"
		found := false
		for _, r := range resources {
			if r.Kind == kind {
				value += r.SHA256 + ":" + strconv.FormatInt(r.Bytes, 10)
				found = true
				break
			}
		}
		if !found {
			value += "absent"
		}
		value += "\n"
	}
	return relayGeoHash([]byte(value))
}
func (t *relayGeoTicket) close() {
	// A lease timer may retain this small ticket until expiry. Retire the large
	// owned bytes/readers immediately once this transaction is actually idle.
	t.data = nil
	t.ip = nil
	t.asn = nil
	if t.stage != nil {
		_ = t.stage.Close()
	}
	if t.inbox != nil {
		_ = t.inbox.Close()
	}
	if t.dir != nil {
		_ = t.dir.Close()
	}
}
func (t *relayGeoTicket) linkedHome() error {
	var held, linked unix.Stat_t
	physical, err := filepath.EvalSymlinks(t.home)
	if err != nil || physical != t.home || unix.Fstat(int(t.dir.Fd()), &held) != nil || unix.Lstat(t.home, &linked) != nil || held.Dev != t.root.Dev || held.Ino != t.root.Ino || linked.Dev != held.Dev || linked.Ino != held.Ino || held.Uid != t.root.Uid || held.Gid != t.root.Gid || held.Mode&unix.S_IFMT != unix.S_IFDIR || held.Mode&07777 != 0700 || linked.Uid != held.Uid || linked.Gid != held.Gid || linked.Mode != held.Mode {
		return ErrRelayLocalGeo
	}
	return nil
}
func (t *relayGeoTicket) check(ctx context.Context) error {
	if ctx.Err() != nil || t.cancelled.Load() || !time.Now().Before(t.deadline) {
		return ErrRelayLocalGeo
	}
	if t.linkedHome() != nil {
		return ErrRelayLocalGeo
	}
	if t.stage != nil {
		return t.linkedStage()
	}
	return nil
}
func (t *relayGeoTicket) readAt(dir *os.File, name string) ([]byte, unix.Stat_t, error) {
	var before, after, linked unix.Stat_t
	fd, err := unix.Openat(int(dir.Fd()), name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, before, err
	}
	f := os.NewFile(uintptr(fd), name)
	defer f.Close()
	if unix.Fstat(fd, &before) != nil || before.Mode&unix.S_IFMT != unix.S_IFREG || before.Mode&07777 != 0600 || before.Uid != t.root.Uid || before.Gid != t.root.Gid || before.Nlink != 1 || before.Size <= 0 || before.Size > relayGeoLimit {
		return nil, before, ErrRelayLocalGeo
	}
	data, err := io.ReadAll(io.LimitReader(f, relayGeoLimit+1))
	if err != nil || len(data) != int(before.Size) || unix.Fstat(fd, &after) != nil || unix.Fstatat(int(dir.Fd()), name, &linked, unix.AT_SYMLINK_NOFOLLOW) != nil || !relayGeoSame(before, after) || !relayGeoSame(before, linked) {
		return nil, before, ErrRelayLocalGeo
	}
	return data, before, nil
}

// Hash immutable/old files with a fixed64KiB buffer rather than repeatedly
// retaining128MiB old/candidate/retained copies during one transaction.
func (t *relayGeoTicket) hashAt(dir *os.File, name string) (string, unix.Stat_t, error) {
	var before, after, linked unix.Stat_t
	fd, err := unix.Openat(int(dir.Fd()), name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return "", before, err
	}
	f := os.NewFile(uintptr(fd), name)
	defer f.Close()
	if unix.Fstat(fd, &before) != nil || before.Mode&unix.S_IFMT != unix.S_IFREG || before.Mode&07777 != 0600 || before.Uid != t.root.Uid || before.Gid != t.root.Gid || before.Nlink != 1 || before.Size <= 0 || before.Size > relayGeoLimit {
		return "", before, ErrRelayLocalGeo
	}
	hash := sha256.New()
	n, err := io.CopyBuffer(hash, io.LimitReader(f, relayGeoLimit+1), make([]byte, 64*1024))
	if err != nil || n != before.Size || unix.Fstat(fd, &after) != nil || unix.Fstatat(int(dir.Fd()), name, &linked, unix.AT_SYMLINK_NOFOLLOW) != nil || !relayGeoSame(before, after) || !relayGeoSame(before, linked) {
		return "", before, ErrRelayLocalGeo
	}
	return hex.EncodeToString(hash.Sum(nil)), before, nil
}
func (t *relayGeoTicket) verifyResources(skip string) error {
	relayGeoState.Lock()
	resources := append([]RelayGeoResource(nil), relayGeoState.resources...)
	relayGeoState.Unlock()
	for _, kind := range relayKinds {
		if kind == skip {
			continue
		}
		var known *RelayGeoResource
		for i := range resources {
			if resources[i].Kind == kind {
				known = &resources[i]
				break
			}
		}
		digest, st, err := t.hashAt(t.dir, relayNames[kind])
		if known == nil {
			if !os.IsNotExist(err) {
				return ErrRelayLocalGeo
			}
			continue
		}
		if err != nil || digest != known.SHA256 || st.Size != known.Bytes || relayGeoActive(kind) != known.Active {
			return ErrRelayLocalGeo
		}
	}
	return nil
}
func relayGeoOpenHome() (*relayGeoTicket, error) {
	home := C.Path.HomeDir()
	if !relayLocalGeoControlled || !filepath.IsAbs(home) {
		return nil, ErrRelayLocalGeo
	}
	fd, err := unix.Open(home, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, ErrRelayLocalGeo
	}
	t := &relayGeoTicket{dir: os.NewFile(uintptr(fd), home), home: home}
	if unix.Fstat(fd, &t.root) != nil || t.root.Uid == 0 || (t.root.Uid != uint32(os.Getuid()) && os.Geteuid() != 0) || t.linkedHome() != nil {
		t.close()
		return nil, ErrRelayLocalGeo
	}
	return t, nil
}
func (t *relayGeoTicket) linkedStage() error {
	var inbox, stage unix.Stat_t
	if unix.Fstatat(int(t.dir.Fd()), "RelayGeoInbox", &inbox, unix.AT_SYMLINK_NOFOLLOW) != nil || unix.Fstatat(int(t.inbox.Fd()), t.blobID, &stage, unix.AT_SYMLINK_NOFOLLOW) != nil || inbox.Dev != t.inboxRoot.Dev || inbox.Ino != t.inboxRoot.Ino || stage.Dev != t.stageRoot.Dev || stage.Ino != t.stageRoot.Ino || inbox.Uid != t.root.Uid || stage.Uid != t.root.Uid || inbox.Gid != t.root.Gid || stage.Gid != t.root.Gid || inbox.Mode&07777 != 0700 || stage.Mode&07777 != 0700 {
		return ErrRelayLocalGeo
	}
	return nil
}
func (t *relayGeoTicket) openStage(blob string) error {
	fd, err := unix.Openat(int(t.dir.Fd()), "RelayGeoInbox", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return ErrRelayLocalGeo
	}
	t.inbox = os.NewFile(uintptr(fd), "RelayGeoInbox")
	if unix.Fstat(fd, &t.inboxRoot) != nil || t.inboxRoot.Uid != t.root.Uid || t.inboxRoot.Gid != t.root.Gid || t.inboxRoot.Mode&07777 != 0700 {
		return ErrRelayLocalGeo
	}
	child, err := unix.Openat(fd, blob, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return ErrRelayLocalGeo
	}
	t.stage = os.NewFile(uintptr(child), blob)
	if unix.Fstat(child, &t.stageRoot) != nil || t.stageRoot.Uid != t.root.Uid || t.stageRoot.Gid != t.root.Gid || t.stageRoot.Mode&07777 != 0700 {
		return ErrRelayLocalGeo
	}
	return t.linkedStage()
}
func RelayLocalGeoState(ctx context.Context) (RelayGeoReceipt, error) {
	relayGeoState.Lock()
	if relayGeoState.uncertain {
		relayGeoState.Unlock()
		return RelayGeoReceipt{Version: 1, Status: "uncertain"}, ErrRelayLocalGeo
	}
	if relayGeoState.head != "" {
		r := RelayGeoReceipt{Version: 1, Capability: "local-geodata-v1", BootID: relayGeoState.bootID, Sequence: relayGeoState.sequence, GenerationSHA256: relayGeoState.head, Resources: append([]RelayGeoResource(nil), relayGeoState.resources...)}
		relayGeoState.Unlock()
		return r, nil
	}
	if relayGeoState.initializing {
		relayGeoState.Unlock()
		return RelayGeoReceipt{Version: 1, Status: "busy"}, ErrRelayLocalGeo
	}
	relayGeoState.initializing = true
	relayGeoState.Unlock()
	defer func() { relayGeoState.Lock(); relayGeoState.initializing = false; relayGeoState.Unlock() }()
	t, err := relayGeoOpenHome()
	if err != nil {
		return RelayGeoReceipt{}, err
	}
	defer t.close()
	var resources []RelayGeoResource
	for _, kind := range relayKinds {
		digest, identity, err := t.hashAt(t.dir, relayNames[kind])
		if os.IsNotExist(err) {
			continue
		}
		if err != nil || ctx.Err() != nil {
			return RelayGeoReceipt{}, ErrRelayLocalGeo
		}
		resources = append(resources, RelayGeoResource{kind, digest, identity.Size, relayGeoActive(kind)})
	}
	if !relayGeoTotal(resources, "", 0) {
		return RelayGeoReceipt{}, ErrRelayLocalGeo
	}
	boot, err := relayNewUUID()
	if err != nil || t.linkedHome() != nil {
		return RelayGeoReceipt{}, ErrRelayLocalGeo
	}
	relayGeoState.Lock()
	relayGeoState.bootID = boot
	relayGeoState.resources = resources
	relayGeoState.head = relayGeoHead(boot, 0, resources)
	relayGeoState.Unlock()
	return RelayLocalGeoState(ctx)
}
func relayGeoSelector(value string) bool {
	if value == "" || len(value) > 256 || !utf8.ValidString(value) || strings.TrimSpace(value) != value || strings.Contains(value, ",") {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}
func PrepareRelayLocalGeo(ctx context.Context, input RelayGeoPrepare) (RelayGeoReceipt, error) {
	start := time.Now()
	lease := input.LeaseMS
	if lease == 0 {
		lease = 30000
	}
	if lease < 1000 || lease > 120000 || !relayGeoSHA(input.OldSHA256) || !relayGeoSHA(input.NewSHA256) || input.OldSHA256 == input.NewSHA256 || !relayGeoSHA(input.ExpectedGenerationSHA256) || !relayGeoUUID(input.BlobID) || !relayGeoSelector(input.Selector) || relayNames[input.Kind] == "" || !relayGeoActive(input.Kind) || updatingGeo.Load() {
		return RelayGeoReceipt{}, ErrRelayLocalGeo
	}
	relayGeoState.Lock()
	if relayGeoState.preparing || relayGeoState.ticket != nil || relayGeoState.initializing || relayGeoState.uncertain {
		relayGeoState.Unlock()
		return RelayGeoReceipt{Version: 1, Status: "busy"}, ErrRelayLocalGeo
	}
	relayGeoState.preparing = true
	relayGeoState.Unlock()
	defer func() { relayGeoState.Lock(); relayGeoState.preparing = false; relayGeoState.Unlock() }()
	state, err := RelayLocalGeoState(ctx)
	if err != nil || state.GenerationSHA256 != input.ExpectedGenerationSHA256 || state.Sequence >= relayGeoMaximumSequence {
		return RelayGeoReceipt{}, ErrRelayLocalGeo
	}
	found := false
	for _, r := range state.Resources {
		if r.Kind == input.Kind && r.SHA256 == input.OldSHA256 {
			found = true
		}
	}
	if !found {
		return RelayGeoReceipt{Version: 1, Status: "unsupported"}, ErrRelayLocalGeo
	}
	t, err := relayGeoOpenHome()
	if err != nil {
		return RelayGeoReceipt{}, err
	}
	owned := false
	defer func() {
		if !owned {
			t.close()
		}
	}()
	t.kind = input.Kind
	t.name = relayNames[input.Kind]
	t.old = input.OldSHA256
	t.next = input.NewSHA256
	t.head = state.GenerationSHA256
	t.sequence = state.Sequence
	t.blobID = input.BlobID
	t.deadline = start.Add(time.Duration(lease) * time.Millisecond)
	if t.openStage(input.BlobID) != nil || t.verifyResources("") != nil {
		return RelayGeoReceipt{}, ErrRelayLocalGeo
	}
	old, previous, err := t.hashAt(t.dir, t.name)
	if err != nil || old != t.old {
		return RelayGeoReceipt{}, ErrRelayLocalGeo
	}
	var stagedBudget unix.Stat_t
	if unix.Fstatat(int(t.stage.Fd()), t.name, &stagedBudget, unix.AT_SYMLINK_NOFOLLOW) != nil || !relayGeoTotal(state.Resources, t.kind, stagedBudget.Size) {
		return RelayGeoReceipt{}, ErrRelayLocalGeo
	}
	data, staged, err := t.readAt(t.stage, t.name)
	if err != nil || relayGeoHash(data) != t.next {
		return RelayGeoReceipt{}, ErrRelayLocalGeo
	}
	t.previous = previous
	t.staged = staged
	t.data = data
	switch input.Kind {
	case "geosite-dat", "geoip-dat":
		loader, e := geodata.GetGeoDataLoader("standard")
		if e != nil {
			return RelayGeoReceipt{}, ErrRelayLocalGeo
		}
		if input.Kind == "geosite-dat" {
			_, err = loader.LoadSiteByBytes(data, strings.Split(strings.TrimPrefix(input.Selector, "!"), "@")[0])
		} else {
			_, err = loader.LoadIPByBytes(data, strings.TrimPrefix(input.Selector, "!"))
		}
	case "country-mmdb":
		t.ip, err = mmdb.PrepareIP(data)
	case "asn-mmdb":
		t.asn, err = mmdb.PrepareASN(data)
	}
	if err != nil || t.check(ctx) != nil {
		return RelayGeoReceipt{}, ErrRelayLocalGeo
	}
	var nonce [32]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return RelayGeoReceipt{}, ErrRelayLocalGeo
	}
	t.nonce = hex.EncodeToString(nonce[:])
	relayGeoState.Lock()
	if relayGeoState.ticket != nil || relayGeoState.uncertain || relayGeoState.head != t.head || ctx.Err() != nil || !time.Now().Before(t.deadline) {
		relayGeoState.Unlock()
		return RelayGeoReceipt{Version: 1, Status: "busy"}, ErrRelayLocalGeo
	}
	relayGeoState.ticket = t
	relayGeoState.Unlock()
	owned = true
	time.AfterFunc(time.Until(t.deadline), func() {
		relayGeoState.Lock()
		idle := relayGeoState.ticket == t && !t.committing
		if idle {
			relayGeoState.ticket = nil
			t.cancelled.Store(true)
		}
		relayGeoState.Unlock()
		if idle {
			t.close()
		}
	})
	return RelayGeoReceipt{Version: 1, Status: "prepared", BootID: state.BootID, Kind: t.kind, Nonce: t.nonce, OldSHA256: t.old, NewSHA256: t.next, Bytes: int64(len(data)), Sequence: t.sequence, PreviousGenerationSHA256: t.head, RemainingMS: time.Until(t.deadline).Milliseconds()}, nil
}
func CancelRelayLocalGeo(nonce string) RelayGeoReceipt {
	relayGeoState.Lock()
	t := relayGeoState.ticket
	if t == nil || t.nonce != nonce {
		relayGeoState.Unlock()
		return RelayGeoReceipt{Version: 1, Status: "stale"}
	}
	t.cancelled.Store(true)
	idle := !t.committing
	if idle {
		relayGeoState.ticket = nil
	}
	entered := t.entered.Load()
	relayGeoState.Unlock()
	if idle {
		t.close()
	}
	status := "cancelled"
	if entered {
		status = "uncertain"
	}
	return RelayGeoReceipt{Version: 1, Status: status}
}
func CommitRelayLocalGeo(ctx context.Context, nonce string) (receipt RelayGeoReceipt, err error) {
	relayGeoState.Lock()
	t := relayGeoState.ticket
	if t == nil || t.nonce != nonce || t.committing || relayGeoState.head != t.head || relayGeoState.uncertain {
		relayGeoState.Unlock()
		return RelayGeoReceipt{Version: 1, Status: "stale"}, ErrRelayLocalGeo
	}
	t.committing = true
	boot := relayGeoState.bootID
	relayGeoState.Unlock()
	defer func() {
		relayGeoState.Lock()
		if relayGeoState.ticket == t {
			relayGeoState.ticket = nil
		}
		if err != nil && t.entered.Load() {
			relayGeoState.uncertain = true
		}
		relayGeoState.Unlock()
		t.close()
		if err != nil {
			receipt = RelayGeoReceipt{Version: 1, Status: "stale"}
			if t.entered.Load() {
				receipt.Status = "uncertain"
			}
		}
	}()
	if t.check(ctx) != nil || t.verifyResources("") != nil {
		return receipt, ErrRelayLocalGeo
	}
	old, previous, err := t.hashAt(t.dir, t.name)
	if err != nil || !relayGeoSame(previous, t.previous) || old != t.old {
		return receipt, ErrRelayLocalGeo
	}
	staged, source, err := t.hashAt(t.stage, t.name)
	if err != nil || !relayGeoSame(source, t.staged) || staged != t.next || t.check(ctx) != nil {
		return receipt, ErrRelayLocalGeo
	}
	relayGeoState.Lock()
	if t.cancelled.Load() || ctx.Err() != nil || !time.Now().Before(t.deadline) || relayGeoState.head != t.head {
		relayGeoState.Unlock()
		return receipt, ErrRelayLocalGeo
	}
	t.entered.Store(true)
	relayGeoState.Unlock()
	name := "RelayGeo.retained-" + t.nonce
	fd, err := unix.Openat(int(t.dir.Fd()), name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return receipt, ErrRelayLocalGeo
	}
	f := os.NewFile(uintptr(fd), name)
	var published unix.Stat_t
	chmodErr := unix.Fchmod(fd, 0600)
	if chmodErr != nil {
		_ = f.Close()
		return receipt, ErrRelayLocalGeo
	}
	chownErr := unix.Fchown(fd, int(t.root.Uid), int(t.root.Gid))
	if chownErr != nil {
		_ = f.Close()
		return receipt, ErrRelayLocalGeo
	}
	n, writeErr := f.Write(t.data)
	syncErr := f.Sync()
	statErr := unix.Fstat(fd, &published)
	closeErr := f.Close()
	if chownErr != nil || writeErr != nil || n != len(t.data) || syncErr != nil || statErr != nil || closeErr != nil || published.Uid != t.root.Uid || published.Gid != t.root.Gid {
		return receipt, ErrRelayLocalGeo
	}
	old, previous, err = t.hashAt(t.dir, t.name)
	if err != nil || !relayGeoSame(previous, t.previous) || old != t.old {
		return receipt, ErrRelayLocalGeo
	}
	candidate, candidateID, err := t.hashAt(t.dir, name)
	if err != nil || candidateID.Dev != published.Dev || candidateID.Ino != published.Ino || candidate != t.next || t.check(ctx) != nil || t.verifyResources(t.kind) != nil {
		return receipt, ErrRelayLocalGeo
	}
	if err = unix.RenameatxNp(int(t.dir.Fd()), name, int(t.dir.Fd()), t.name, unix.RENAME_SWAP); err != nil {
		return receipt, ErrRelayLocalGeo
	}
	current, currentID, currentErr := t.hashAt(t.dir, t.name)
	retained, retainedID, retainedErr := t.hashAt(t.dir, name)
	if currentErr != nil || retainedErr != nil || currentID.Dev != published.Dev || currentID.Ino != published.Ino || retainedID.Dev != previous.Dev || retainedID.Ino != previous.Ino || current != t.next || retained != t.old || t.linkedHome() != nil {
		return receipt, ErrRelayLocalGeo
	}
	syncErr = t.dir.Sync()
	switch t.kind {
	case "geoip-dat":
		geodata.ClearGeoIPCache()
	case "geosite-dat":
		geodata.ClearGeoSiteCache()
	case "country-mmdb":
		mmdb.PublishIP(t.ip)
	case "asn-mmdb":
		mmdb.PublishASN(t.asn)
	}
	if syncErr != nil {
		return receipt, ErrRelayLocalGeo
	}
	relayGeoState.Lock()
	for i, r := range relayGeoState.resources {
		if r.Kind == t.kind {
			relayGeoState.resources[i].SHA256 = t.next
			relayGeoState.resources[i].Bytes = int64(len(t.data))
		}
	}
	relayGeoState.sequence++
	seq := relayGeoState.sequence
	relayGeoState.head = relayGeoHead(boot, seq, relayGeoState.resources)
	head := relayGeoState.head
	relayGeoState.Unlock()
	return RelayGeoReceipt{Version: 1, Status: "applied", BootID: boot, Kind: t.kind, OldSHA256: t.old, NewSHA256: t.next, Bytes: int64(len(t.data)), Sequence: seq, PreviousGenerationSHA256: t.head, GenerationSHA256: head, Retained: true}, nil
}
