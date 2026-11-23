package inbound

import (
	"net"
	"os"
	"sync"

	"github.com/metacubex/mihomo/log"
	"golang.org/x/sys/unix"
)

func init() {
	if os.Geteuid() == 0 && os.Getenv("RELAY_MANAGED_TUN_HANDOFF") == "1" {
		relayWrapTCPListener = func(l net.Listener) net.Listener {
			tcp, ok := l.(*net.TCPListener)
			if !ok || !tcp.Addr().(*net.TCPAddr).IP.IsLoopback() {
				return l
			}
			return &handoffTCPListener{TCPListener: tcp}
		}
	}
}

type handoffTCPListener struct {
	*net.TCPListener
	warn sync.Once
}

func (l *handoffTCPListener) Accept() (net.Conn, error) {
	conn, err := l.AcceptTCP()
	if err != nil {
		return nil, err
	}
	// XNU compares the UID of the old connection with the next binder. Set
	// the flag on the accepted socket only. The listener stays exclusive.
	raw, err := conn.SyscallConn()
	if err == nil {
		var optionErr error
		err = raw.Control(func(fd uintptr) {
			optionErr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSESHAREUID, 1)
		})
		if err == nil {
			err = optionErr
		}
	}
	if err != nil {
		l.warn.Do(func() { log.Warnln("Could not prepare loopback connection for TUN handoff: %v", err) })
	}
	return conn, nil
}
