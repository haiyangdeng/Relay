#ifndef RELAY_TUN_DEVICE_H
#define RELAY_TUN_DEVICE_H

#include <stdbool.h>
#include <stdint.h>
#include <net/if.h>
#include <sys/socket.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Low-level macOS device operations, to be called by an authenticated helper's
 * serialized transaction. No routing socket, DNS, shell, path or PID API exists.
 * Interface address ioctls can themselves create connected kernel routes; the
 * enclosing transaction must snapshot/verify those effects and restore them.
 * This interface is not an authorization mechanism or a live acceptance test. */
typedef struct RelayTunDevice RelayTunDevice;
typedef enum {
    RELAY_TUN_DEVICE_OK = 0,
    RELAY_TUN_DEVICE_INVALID,
    RELAY_TUN_DEVICE_PERMISSION,
    RELAY_TUN_DEVICE_EXISTS,
    RELAY_TUN_DEVICE_SYSTEM,
    RELAY_TUN_DEVICE_IDENTITY,
    RELAY_TUN_DEVICE_UNSUPPORTED
} RelayTunDeviceCode;
typedef enum {
    RELAY_TUN_STAGE_NONE = 0,
    RELAY_TUN_STAGE_PERMISSION,
    RELAY_TUN_STAGE_INPUT,
    RELAY_TUN_STAGE_SOCKET,
    RELAY_TUN_STAGE_FD_FLAGS,
    RELAY_TUN_STAGE_CONTROL,
    RELAY_TUN_STAGE_CONNECT,
    RELAY_TUN_STAGE_OBSERVE,
    RELAY_TUN_STAGE_MTU,
    RELAY_TUN_STAGE_IPV4,
    RELAY_TUN_STAGE_IPV6,
    RELAY_TUN_STAGE_DUPLICATE,
    RELAY_TUN_STAGE_CLOSE
} RelayTunDeviceStage;
typedef struct {
    RelayTunDeviceCode code;
    RelayTunDeviceStage stage;
    int system_error;
    bool network_may_have_changed;
} RelayTunDeviceError;
typedef struct {
    int family;
    uint8_t prefix;
    uint8_t address[16];
    uint8_t mask[16];
} RelayTunDevicePrefix;
typedef struct {
    char name[IFNAMSIZ];
    unsigned int interface_index;
    uint32_t control_id;
    uint32_t control_unit;
    uint32_t mtu;
} RelayTunDeviceSnapshot;

/* Pure validation: "utun" means a new automatically allocated unit; a strict
 * utunN requests N+1 without integer wrapping. No existing interface is adopted.
 * Prefixes retain host bits; masks are network-order bytes. No values clamp. */
RelayTunDeviceCode relay_tun_device_parse_name(const char *name, uint32_t *kernel_unit,
                                             RelayTunDeviceError *error);
RelayTunDeviceCode relay_tun_device_validate_mtu(uint32_t mtu, RelayTunDeviceError *error);
RelayTunDeviceCode relay_tun_device_prefix_mask(int family, unsigned int prefix,
                                              uint8_t mask[16], RelayTunDeviceError *error);
RelayTunDeviceCode relay_tun_device_parse_prefix(const char *cidr, int family,
                                               RelayTunDevicePrefix *prefix,
                                               RelayTunDeviceError *error);
RelayTunDeviceCode relay_tun_device_ipv6_destination(const RelayTunDevicePrefix *prefix,
                                                   uint8_t destination[16],
                                                   RelayTunDeviceError *error);

/* Every live entry first requires real AND effective UID 0, before touching
 * sockets, ioctls, interface lookup or handle memory. The helper must separately
 * authenticate callers and bind consent, resource identities and recovery data.
 * Handles must not be shared across concurrent calls or copied by a caller. */
RelayTunDeviceCode relay_tun_device_create(const char *requested_name, RelayTunDevice **out,
                                         RelayTunDeviceError *error);
RelayTunDeviceCode relay_tun_device_snapshot(RelayTunDevice *device, RelayTunDeviceSnapshot *out,
                                           RelayTunDeviceError *error);
RelayTunDeviceCode relay_tun_device_set_mtu(RelayTunDevice *device, uint32_t mtu,
                                          RelayTunDeviceError *error);
RelayTunDeviceCode relay_tun_device_add_ipv4(RelayTunDevice *device,
                                           const RelayTunDevicePrefix *prefix,
                                           RelayTunDeviceError *error);
RelayTunDeviceCode relay_tun_device_add_ipv6(RelayTunDevice *device,
                                           const RelayTunDevicePrefix *prefix,
                                           RelayTunDeviceError *error);
/* Returns a new CLOEXEC FD owned by the caller (for authenticated FD transfer).
 * It never accepts, adopts or closes a caller-provided integer descriptor. */
RelayTunDeviceCode relay_tun_device_duplicate_fd(RelayTunDevice *device, int *out,
                                               RelayTunDeviceError *error);
/* A changed identity refuses close and retains the handle. After an attempted
 * close, the pointer is cleared even if the OS result is uncertain: do not retry
 * closing an integer which may already have been released and reused. */
RelayTunDeviceCode relay_tun_device_close(RelayTunDevice **device, RelayTunDeviceError *error);

#ifdef RELAY_TUN_DEVICE_TESTING
typedef struct {
    uint64_t socket_calls, ioctl_calls, connect_calls, observe_calls, fd_calls, close_calls;
} RelayTunDeviceTestCounters;
RelayTunDeviceTestCounters relay_tun_device_test_counters(void);
#endif

#ifdef __cplusplus
}
#endif
#endif
