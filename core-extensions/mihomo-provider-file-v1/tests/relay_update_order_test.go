package resource_test

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/metacubex/mihomo/common/utils"
	"github.com/metacubex/mihomo/component/resource"
	P "github.com/metacubex/mihomo/constant/provider"
)

type gatedFileVehicle struct {
	calls          atomic.Int32
	oldReadStarted chan struct{}
	releaseOldRead chan struct{}
	newReadStarted chan struct{}
}

func (v *gatedFileVehicle) Read(_ context.Context, _ utils.HashType) ([]byte, utils.HashType, error) {
	var data []byte
	switch v.calls.Add(1) {
	case 1:
		data = []byte("A")
	case 2:
		// A completed file read may be preempted before Fetcher.loadBuf locks.
		data = []byte("A")
		close(v.oldReadStarted)
		<-v.releaseOldRead
	case 3:
		data = []byte("B")
		close(v.newReadStarted)
	default:
		return nil, utils.HashType{}, fmt.Errorf("unexpected extra Update")
	}
	return data, utils.MakeHash(data), nil
}
func (*gatedFileVehicle) Write([]byte) error  { return fmt.Errorf("file update must not write vehicle") }
func (*gatedFileVehicle) Path() string        { return "synthetic-not-opened" }
func (*gatedFileVehicle) Url() string         { return "" }
func (*gatedFileVehicle) Proxy() string       { return "" }
func (*gatedFileVehicle) Type() P.VehicleType { return P.File }

func TestRelayConcurrentUpdateCannotReplayOldFileAfterNewPUT(t *testing.T) {
	v := &gatedFileVehicle{oldReadStarted: make(chan struct{}), releaseOldRead: make(chan struct{}), newReadStarted: make(chan struct{})}
	var strategy atomic.Value
	f := resource.NewFetcher[string]("synthetic", 0, v, nil, func(b []byte) (string, error) { return string(b), nil }, func(s string) { strategy.Store(s) })
	defer f.Close()
	if _, _, err := f.Update(); err != nil {
		t.Fatal(err)
	}
	oldDone, newDone := make(chan error, 1), make(chan error, 1)
	go func() { _, _, err := f.Update(); oldDone <- err }()
	select {
	case <-v.oldReadStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("old read never entered")
	}
	var released bool
	defer func() {
		if !released {
			close(v.releaseOldRead)
		}
	}()
	newAttempted := make(chan struct{})
	go func() { close(newAttempted); _, _, err := f.Update(); newDone <- err }()
	<-newAttempted
	newReturnedBeforeOldRelease := false
	select {
	case err := <-newDone:
		if err != nil {
			t.Fatal(err)
		}
		newReturnedBeforeOldRelease = true
	case <-time.After(200 * time.Millisecond):
		// Fixed serialization blocks Read itself. This guard only releases the
		// deliberately blocked old read; it is not production scheduling logic.
	}
	close(v.releaseOldRead)
	released = true
	select {
	case err := <-oldDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("old Update did not drain")
	}
	if !newReturnedBeforeOldRelease {
		select {
		case err := <-newDone:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("new Update did not drain")
		}
	}
	t.Logf("newReturnedBeforeOldRelease=%v; bothCounts=1; finalStrategy=%q; vehicleReads=%d", newReturnedBeforeOldRelease, strategy.Load(), v.calls.Load())
	if strategy.Load() != "B" {
		t.Fatalf("stale strategy after successful new local PUT: got %v want B", strategy.Load())
	}
}

type sideFileVehicle struct{ *gatedFileVehicle }

func (*sideFileVehicle) Write([]byte) error { return nil }
func TestRelaySideUpdateCannotBeOverwrittenByAnEarlierFileRead(t *testing.T) {
	v := &sideFileVehicle{&gatedFileVehicle{oldReadStarted: make(chan struct{}), releaseOldRead: make(chan struct{}), newReadStarted: make(chan struct{})}}
	var strategy atomic.Value
	f := resource.NewFetcher[string]("synthetic-side", 0, v, nil, func(b []byte) (string, error) { return string(b), nil }, func(s string) { strategy.Store(s) })
	defer f.Close()
	if _, _, err := f.Update(); err != nil {
		t.Fatal(err)
	}
	oldDone, newDone := make(chan error, 1), make(chan error, 1)
	go func() { _, _, err := f.Update(); oldDone <- err }()
	select {
	case <-v.oldReadStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("old read gate")
	}
	released := false
	defer func() {
		if !released {
			close(v.releaseOldRead)
		}
	}()
	attempted := make(chan struct{})
	go func() { close(attempted); _, _, err := f.SideUpdate([]byte("B")); newDone <- err }()
	<-attempted
	early := false
	select {
	case err := <-newDone:
		if err != nil {
			t.Fatal(err)
		}
		early = true
	case <-time.After(200 * time.Millisecond):
	}
	close(v.releaseOldRead)
	released = true
	select {
	case err := <-oldDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("old drain")
	}
	if !early {
		select {
		case err := <-newDone:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("side drain")
		}
	}
	t.Logf("sideReturnedBeforeOldRelease=%v; finalStrategy=%q", early, strategy.Load())
	if strategy.Load() != "B" {
		t.Fatalf("old read replay after SideUpdate: %v", strategy.Load())
	}
}

type failingFileVehicle struct {
	*gatedFileVehicle
	calls atomic.Int32
}

func (v *failingFileVehicle) Read(context.Context, utils.HashType) ([]byte, utils.HashType, error) {
	if v.calls.Add(1) == 1 {
		return nil, utils.HashType{}, fmt.Errorf("synthetic read failure")
	}
	b := []byte("B")
	return b, utils.MakeHash(b), nil
}
func TestRelayFileReadFailureReleasesTheOuterLock(t *testing.T) {
	v := &failingFileVehicle{gatedFileVehicle: &gatedFileVehicle{}}
	f := resource.NewFetcher[string]("error", 0, v, nil, func(b []byte) (string, error) { return string(b), nil }, nil)
	defer f.Close()
	if _, _, err := f.Update(); err == nil {
		t.Fatal("missing injected error")
	}
	done := make(chan error, 1)
	go func() {
		s, _, err := f.Update()
		if s != "B" && err == nil {
			err = fmt.Errorf("bad body %s", s)
		}
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("outer lock retained after read error")
	}
}

type constantFileVehicle struct{ *gatedFileVehicle }

func (*constantFileVehicle) Read(context.Context, utils.HashType) ([]byte, utils.HashType, error) {
	b := []byte("B")
	return b, utils.MakeHash(b), nil
}
func TestRelayInitialFallbackDoesNotRecursivelyAcquireTheOuterLock(t *testing.T) {
	v := &constantFileVehicle{&gatedFileVehicle{}}
	f := resource.NewFetcher[string]("initial", 0, v, nil, func(b []byte) (string, error) { return string(b), nil }, nil)
	defer f.Close()
	// No file exists at this relative fixture-only name. Initial's read fallback
	// reaches the private helper; its missing watcher target is an expected error.
	done := make(chan struct{})
	go func() { _, _ = f.Initial(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Initial fallback recursively locked")
	}
	if _, _, err := f.Update(); err != nil {
		t.Fatal(err)
	}
}

type equalLegacyHashVehicle struct {
	calls          atomic.Int32
	writes         atomic.Int32
	failFirstWrite bool
	nonFile        bool
}

func (v *equalLegacyHashVehicle) Read(context.Context, utils.HashType) ([]byte, utils.HashType, error) {
	n := v.calls.Add(1)
	body := []byte("A")
	if n > 1 {
		body = []byte("B")
	}
	return body, utils.MakeHash([]byte("A")), nil
}
func (v *equalLegacyHashVehicle) Write([]byte) error {
	if v.writes.Add(1) == 1 && v.failFirstWrite {
		return fmt.Errorf("synthetic write failure")
	}
	return nil
}
func (*equalLegacyHashVehicle) Path() string  { return "synthetic-not-opened" }
func (*equalLegacyHashVehicle) Url() string   { return "" }
func (*equalLegacyHashVehicle) Proxy() string { return "" }
func (v *equalLegacyHashVehicle) Type() P.VehicleType {
	if v.nonFile {
		return P.HTTP
	}
	return P.File
}

func TestRelayFileStrongDedupRejectsEqualLegacyHashForDifferentBytes(t *testing.T) {
	// This injects equal legacy MD5 results; it is a contract boundary test,
	// NOT a claimed constructed collision of two valid real rule documents.
	v := &equalLegacyHashVehicle{}
	var parses atomic.Int32
	var current atomic.Value
	f := resource.NewFetcher[string]("strong-file", 0, v, nil, func(b []byte) (string, error) { parses.Add(1); return string(b), nil }, func(s string) { current.Store(s) })
	defer f.Close()
	if _, _, err := f.Update(); err != nil {
		t.Fatal(err)
	}
	_, same, err := f.Update()
	if err != nil {
		t.Fatal(err)
	}
	if same || current.Load() != "B" || parses.Load() != 2 {
		t.Fatalf("equal legacy hash skipped different file: same=%v strategy=%v parses=%d", same, current.Load(), parses.Load())
	}
	_, same, err = f.Update()
	if err != nil || !same || parses.Load() != 2 {
		t.Fatalf("exact repeated file was reparsed: same=%v err=%v parses=%d", same, err, parses.Load())
	}
}
func TestRelayFailedFileParseDoesNotAdvanceStrongDedup(t *testing.T) {
	v := &equalLegacyHashVehicle{}
	var reject atomic.Bool
	reject.Store(true)
	var current atomic.Value
	f := resource.NewFetcher[string]("failed-parse", 0, v, nil, func(b []byte) (string, error) {
		if string(b) == "B" && reject.Swap(false) {
			return "", fmt.Errorf("synthetic parser failure")
		}
		return string(b), nil
	}, func(s string) { current.Store(s) })
	defer f.Close()
	if _, _, err := f.Update(); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.Update(); err == nil {
		t.Fatal("different B must reach parser before strong digest commits")
	}
	if _, same, err := f.Update(); err != nil || same || current.Load() != "B" {
		t.Fatalf("rejected data adopted into strong dedup: same=%v err=%v strategy=%v", same, err, current.Load())
	}
}
func TestRelayFailedSideFileWriteDoesNotAdvanceStrongDedup(t *testing.T) {
	v := &equalLegacyHashVehicle{failFirstWrite: true}
	var current atomic.Value
	f := resource.NewFetcher[string]("failed-write", 0, v, nil, func(b []byte) (string, error) { return string(b), nil }, func(s string) { current.Store(s) })
	defer f.Close()
	if _, _, err := f.Update(); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.SideUpdate([]byte("B")); err == nil {
		t.Fatal("injected write failure was ignored")
	}
	if _, same, err := f.SideUpdate([]byte("B")); err != nil || same || current.Load() != "B" {
		t.Fatalf("failed write advanced dedup: same=%v err=%v strategy=%v", same, err, current.Load())
	}
}
func TestRelayNonFileLegacyHashContractRemainsUnchanged(t *testing.T) {
	v := &equalLegacyHashVehicle{nonFile: true}
	var parses atomic.Int32
	f := resource.NewFetcher[string]("nonfile", 0, v, nil, func(b []byte) (string, error) { parses.Add(1); return string(b), nil }, nil)
	defer f.Close()
	if _, _, err := f.Update(); err != nil {
		t.Fatal(err)
	}
	if _, same, err := f.Update(); err != nil || !same || parses.Load() != 1 {
		t.Fatalf("nonFile legacy behavior changed: same=%v err=%v parses=%d", same, err, parses.Load())
	}
}
