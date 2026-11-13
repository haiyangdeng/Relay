#include "RelayTunDevice.h"
#if !defined(__APPLE__)
#error RelayTunDevice requires the macOS kernel-control and interface APIs
#endif
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <ifaddrs.h>
#include <limits.h>
#include <net/if_utun.h>
#include <netinet/in.h>
#include <netinet6/in6_var.h>
#include <netinet6/nd6.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/kern_control.h>
#include <sys/sockio.h>
#include <sys/stat.h>
#include <unistd.h>

#define RELAY_DEVICE_MAGIC UINT64_C(0x524c595554554e31)
struct RelayTunDevice {
    uint64_t magic;
    int fd;
    char name[IFNAMSIZ];
    unsigned int index;
    uint32_t control_id, control_unit;
    dev_t fd_device;
    ino_t fd_inode;
};
#ifdef RELAY_TUN_DEVICE_TESTING
static RelayTunDeviceTestCounters test_counters;
#define COUNT(field) (++test_counters.field)
RelayTunDeviceTestCounters relay_tun_device_test_counters(void) { return test_counters; }
#else
#define COUNT(field) ((void)0)
#endif
static int device_socket(int family, int type, int protocol) {
    COUNT(socket_calls); return socket(family, type, protocol);
}
static int device_ioctl(int fd, unsigned long request, void *value) {
    COUNT(ioctl_calls); return ioctl(fd, request, value);
}
static int close_owned(int fd) { COUNT(close_calls); return close(fd); }
static RelayTunDeviceCode finish(RelayTunDeviceError *error, RelayTunDeviceCode code,
                                RelayTunDeviceStage stage, int system_error, bool changed) {
    if (error) *error = (RelayTunDeviceError){code, stage, system_error, changed};
    return code;
}
static RelayTunDeviceCode ok(RelayTunDeviceError *error) {
    return finish(error, RELAY_TUN_DEVICE_OK, RELAY_TUN_STAGE_NONE, 0, false);
}
static bool privileged(RelayTunDeviceError *error) {
    if (getuid() == 0 && geteuid() == 0) return true;
    finish(error, RELAY_TUN_DEVICE_PERMISSION, RELAY_TUN_STAGE_PERMISSION, EPERM, false);
    return false;
}
RelayTunDeviceCode relay_tun_device_parse_name(const char *name, uint32_t *unit,
                                             RelayTunDeviceError *error) {
    if (!name || !unit || strnlen(name, IFNAMSIZ) >= IFNAMSIZ || strncmp(name, "utun", 4))
        return finish(error, RELAY_TUN_DEVICE_INVALID, RELAY_TUN_STAGE_INPUT, EINVAL, false);
    const char *digits = name + 4;
    if (!*digits) { *unit = 0; return ok(error); }
    if (digits[0] == '0' && digits[1])
        return finish(error, RELAY_TUN_DEVICE_INVALID, RELAY_TUN_STAGE_INPUT, EINVAL, false);
    uint64_t value = 0;
    for (const char *p = digits; *p; ++p) {
        if (*p < '0' || *p > '9')
            return finish(error, RELAY_TUN_DEVICE_INVALID, RELAY_TUN_STAGE_INPUT, EINVAL, false);
        if (value > (UINT32_MAX - UINT64_C(1) - (unsigned)(*p - '0')) / 10)
            return finish(error, RELAY_TUN_DEVICE_INVALID, RELAY_TUN_STAGE_INPUT, EOVERFLOW, false);
        value = value * 10 + (unsigned)(*p - '0');
    }
    *unit = (uint32_t)value + 1;
    return ok(error);
}
RelayTunDeviceCode relay_tun_device_validate_mtu(uint32_t mtu, RelayTunDeviceError *error) {
    if (!mtu || mtu > INT32_MAX)
        return finish(error, RELAY_TUN_DEVICE_UNSUPPORTED, RELAY_TUN_STAGE_INPUT, EINVAL, false);
    /* SIOCSIFMTU takes a signed int. Actual kernel-specific MTU limits are
     * reported by its ioctl; there is no silent 1500/65535 clamp here. */
    return ok(error);
}
RelayTunDeviceCode relay_tun_device_prefix_mask(int family, unsigned int bits,
                                              uint8_t mask[16], RelayTunDeviceError *error) {
    unsigned int bytes = family == AF_INET ? 4 : family == AF_INET6 ? 16 : 0;
    if (!mask || !bytes || bits > bytes * 8)
        return finish(error, RELAY_TUN_DEVICE_INVALID, RELAY_TUN_STAGE_INPUT, EINVAL, false);
    uint8_t value[16] = {0};
    for (unsigned int i = 0; i < bytes; ++i) {
        unsigned int count = bits > i * 8 ? bits - i * 8 : 0;
        value[i] = count >= 8 ? UINT8_MAX : count ? (uint8_t)(UINT8_MAX << (8 - count)) : 0;
    }
    memcpy(mask, value, sizeof(value));
    return ok(error);
}
RelayTunDeviceCode relay_tun_device_parse_prefix(const char *cidr, int family,
                                               RelayTunDevicePrefix *prefix,
                                               RelayTunDeviceError *error) {
    char input[INET6_ADDRSTRLEN + 5];
    if (!cidr || !prefix || (family != AF_INET && family != AF_INET6) ||
        strnlen(cidr, sizeof(input)) >= sizeof(input))
        return finish(error, RELAY_TUN_DEVICE_INVALID, RELAY_TUN_STAGE_INPUT, EINVAL, false);
    memcpy(input, cidr, strlen(cidr) + 1);
    char *slash = strchr(input, '/');
    if (!slash || slash == input || !slash[1] || strchr(slash + 1, '/') ||
        (slash[1] == '0' && slash[2]))
        return finish(error, RELAY_TUN_DEVICE_INVALID, RELAY_TUN_STAGE_INPUT, EINVAL, false);
    *slash++ = 0;
    unsigned int bits = 0;
    for (const char *p = slash; *p; ++p) {
        if (*p < '0' || *p > '9' || bits > 128)
            return finish(error, RELAY_TUN_DEVICE_INVALID, RELAY_TUN_STAGE_INPUT, EINVAL, false);
        bits = bits * 10 + (unsigned)(*p - '0');
    }
    RelayTunDevicePrefix value = {.family = family};
    /* Darwin inet_pton accepts leading-zero IPv4 components and scoped IPv6
     * suffixes which the fixed core's netip.Prefix does not. Reject ambiguity
     * explicitly rather than resolving a caller-supplied scope/interface. */
    for (const char *p = input; *p; ++p) {
        bool digit = *p >= '0' && *p <= '9';
        bool hex = (*p >= 'a' && *p <= 'f') || (*p >= 'A' && *p <= 'F');
        if (!(digit || *p == '.' || (family == AF_INET6 && (hex || *p == ':'))))
            return finish(error, RELAY_TUN_DEVICE_INVALID, RELAY_TUN_STAGE_INPUT, EINVAL, false);
    }
    if (inet_pton(family, input, value.address) != 1 ||
        relay_tun_device_prefix_mask(family, bits, value.mask, error) != RELAY_TUN_DEVICE_OK)
        return finish(error, RELAY_TUN_DEVICE_INVALID, RELAY_TUN_STAGE_INPUT, EINVAL, false);
    const char *ipv4_text = family == AF_INET ? input : strrchr(input, ':');
    if (family == AF_INET6 && ipv4_text) ipv4_text++;
    if (ipv4_text && strchr(ipv4_text, '.')) {
        struct in_addr address; char canonical[INET_ADDRSTRLEN];
        if (inet_pton(AF_INET, ipv4_text, &address) != 1 ||
            !inet_ntop(AF_INET, &address, canonical, sizeof(canonical)) || strcmp(canonical, ipv4_text))
            return finish(error, RELAY_TUN_DEVICE_INVALID, RELAY_TUN_STAGE_INPUT, EINVAL, false);
    }
    value.prefix = (uint8_t)bits;
    *prefix = value;
    return ok(error);
}
static bool valid_prefix(const RelayTunDevicePrefix *prefix, int family) {
    uint8_t mask[16], zero[12] = {0};
    return prefix && prefix->family == family &&
        relay_tun_device_prefix_mask(family, prefix->prefix, mask, NULL) == RELAY_TUN_DEVICE_OK &&
        !memcmp(mask, prefix->mask, 16) &&
        (family != AF_INET || !memcmp(prefix->address + 4, zero, sizeof(zero)));
}
RelayTunDeviceCode relay_tun_device_ipv6_destination(const RelayTunDevicePrefix *prefix,
                                                   uint8_t destination[16],
                                                   RelayTunDeviceError *error) {
    if (!destination || !valid_prefix(prefix, AF_INET6))
        return finish(error, RELAY_TUN_DEVICE_INVALID, RELAY_TUN_STAGE_INPUT, EINVAL, false);
    uint8_t value[16] = {0};
    if (prefix->prefix == 128) {
        memcpy(value, prefix->address, 16);
        int position = 15;
        while (position >= 0 && value[position] == UINT8_MAX) value[position--] = 0;
        if (position < 0)
            return finish(error, RELAY_TUN_DEVICE_UNSUPPORTED, RELAY_TUN_STAGE_INPUT, EOVERFLOW, false);
        value[position]++;
    }
    memcpy(destination, value, 16);
    return ok(error);
}
static RelayTunDeviceCode validate_peer(const struct sockaddr_ctl *address, socklen_t length,
                                       RelayTunDeviceError *error) {
    if (!address || length != sizeof(*address) || address->sc_len != sizeof(*address) || address->sc_family != AF_SYSTEM ||
        address->ss_sysaddr != AF_SYS_CONTROL || !address->sc_id || !address->sc_unit)
        return finish(error, RELAY_TUN_DEVICE_IDENTITY, RELAY_TUN_STAGE_OBSERVE, EPROTOTYPE, false);
    return ok(error);
}
static RelayTunDeviceCode validate_name(const char name[IFNAMSIZ], socklen_t length,
                                       uint32_t peer_unit, RelayTunDeviceError *error) {
    if (!name || length <= 1 || length > IFNAMSIZ || name[length - 1] != 0 ||
        strnlen(name, IFNAMSIZ) != length - 1)
        return finish(error, RELAY_TUN_DEVICE_IDENTITY, RELAY_TUN_STAGE_OBSERVE, EINVAL, false);
    uint32_t unit = 0;
    if (relay_tun_device_parse_name(name, &unit, NULL) != RELAY_TUN_DEVICE_OK || !unit || unit != peer_unit)
        return finish(error, RELAY_TUN_DEVICE_IDENTITY, RELAY_TUN_STAGE_OBSERVE, ENXIO, false);
    return ok(error);
}
static RelayTunDeviceCode creation_failure_after_close(RelayTunDeviceError cause, int status,
                                                       int close_error, RelayTunDeviceError *error) {
    if (status != 0)
        return finish(error, RELAY_TUN_DEVICE_SYSTEM, RELAY_TUN_STAGE_CLOSE, close_error, true);
    return finish(error, cause.code, cause.stage, cause.system_error, true);
}
static RelayTunDeviceCode close_failed_creation(int fd, RelayTunDeviceError cause, RelayTunDeviceError *error) {
    /* A single close attempt owns this integer. Its failure is uncertainty;
     * never retry a descriptor which could already have been released/reused. */
    const int status = close_owned(fd), saved = errno;
    return creation_failure_after_close(cause, status, saved, error);
}
#ifdef RELAY_TUN_DEVICE_TESTING
/* Test-only pure entry points: no descriptor adoption or live syscall seam. */
RelayTunDeviceCode relay_tun_device_test_observation(const struct sockaddr_ctl *peer, socklen_t length,
    const char name[IFNAMSIZ], socklen_t name_length, unsigned int index, RelayTunDeviceError *error) {
    RelayTunDeviceCode result = validate_peer(peer, length, error);
    if (result != RELAY_TUN_DEVICE_OK) return result;
    result = validate_name(name, name_length, peer->sc_unit, error);
    if (result != RELAY_TUN_DEVICE_OK) return result;
    return index ? ok(error) : finish(error, RELAY_TUN_DEVICE_IDENTITY, RELAY_TUN_STAGE_OBSERVE, ENXIO, false);
}
RelayTunDeviceCode relay_tun_device_test_creation_failure(RelayTunDeviceError cause, int close_status,
                                                        int close_error, RelayTunDeviceError *error) {
    return creation_failure_after_close(cause, close_status, close_error, error);
}
#endif
static RelayTunDeviceCode observe_fd(int fd, char name[IFNAMSIZ], struct sockaddr_ctl *address,
                                    unsigned int *index, struct stat *identity,
                                    RelayTunDeviceError *error) {
    COUNT(observe_calls);
    socklen_t address_length = sizeof(*address), name_length = IFNAMSIZ;
    memset(address, 0, sizeof(*address)); memset(name, 0, IFNAMSIZ);
    if (fstat(fd, identity))
        return finish(error, RELAY_TUN_DEVICE_IDENTITY, RELAY_TUN_STAGE_OBSERVE, errno, false);
    if ((identity->st_mode & S_IFMT) != S_IFSOCK)
        return finish(error, RELAY_TUN_DEVICE_IDENTITY, RELAY_TUN_STAGE_OBSERVE, ENOTSOCK, false);
    /* XNU kern_control.c implements pru_peeraddr (ctl_peeraddr), while
     * pru_sockaddr defaults to EOPNOTSUPP. The connected controller is the
     * peer; getsockname cannot establish its control ID/unit identity. */
    if (getpeername(fd, (struct sockaddr *)address, &address_length))
        return finish(error, RELAY_TUN_DEVICE_IDENTITY, RELAY_TUN_STAGE_OBSERVE, errno, false);
    RelayTunDeviceCode result = validate_peer(address, address_length, error);
    if (result != RELAY_TUN_DEVICE_OK) return result;
    if (getsockopt(fd, SYSPROTO_CONTROL, UTUN_OPT_IFNAME, name, &name_length))
        return finish(error, RELAY_TUN_DEVICE_IDENTITY, RELAY_TUN_STAGE_OBSERVE, errno, false);
    result = validate_name(name, name_length, address->sc_unit, error);
    if (result != RELAY_TUN_DEVICE_OK) return result;
    if (!(*index = if_nametoindex(name)))
        return finish(error, RELAY_TUN_DEVICE_IDENTITY, RELAY_TUN_STAGE_OBSERVE, ENXIO, false);
    return ok(error);
}
static RelayTunDeviceCode revalidate(RelayTunDevice *device, RelayTunDeviceError *error) {
    if (!device || device->magic != RELAY_DEVICE_MAGIC || device->fd < 0)
        return finish(error, RELAY_TUN_DEVICE_INVALID, RELAY_TUN_STAGE_OBSERVE, EINVAL, false);
    char name[IFNAMSIZ]; struct sockaddr_ctl address; struct stat identity; unsigned int index;
    RelayTunDeviceCode result = observe_fd(device->fd, name, &address, &index, &identity, error);
    if (result != RELAY_TUN_DEVICE_OK) return result;
    if (strcmp(name, device->name) || index != device->index ||
        address.sc_id != device->control_id || address.sc_unit != device->control_unit ||
        identity.st_dev != device->fd_device || identity.st_ino != device->fd_inode)
        return finish(error, RELAY_TUN_DEVICE_IDENTITY, RELAY_TUN_STAGE_OBSERVE, ESTALE, false);
    return ok(error);
}
RelayTunDeviceCode relay_tun_device_create(const char *requested, RelayTunDevice **out,
                                         RelayTunDeviceError *error) {
    if (!privileged(error)) return RELAY_TUN_DEVICE_PERMISSION;
    uint32_t unit;
    if (!out || *out || relay_tun_device_parse_name(requested, &unit, error) != RELAY_TUN_DEVICE_OK)
        return finish(error, RELAY_TUN_DEVICE_INVALID, RELAY_TUN_STAGE_INPUT, EINVAL, false);
    if (unit) {
        COUNT(observe_calls);
        if (if_nametoindex(requested))
            return finish(error, RELAY_TUN_DEVICE_EXISTS, RELAY_TUN_STAGE_INPUT, EEXIST, false);
    }
    int fd = device_socket(AF_SYSTEM, SOCK_DGRAM, SYSPROTO_CONTROL);
    if (fd < 0) return finish(error, RELAY_TUN_DEVICE_SYSTEM, RELAY_TUN_STAGE_SOCKET, errno, false);
    COUNT(fd_calls);
    if (fcntl(fd, F_SETFD, FD_CLOEXEC)) {
        int saved = errno; close_owned(fd);
        return finish(error, RELAY_TUN_DEVICE_SYSTEM, RELAY_TUN_STAGE_FD_FLAGS, saved, false);
    }
    struct ctl_info control = {0};
    memcpy(control.ctl_name, UTUN_CONTROL_NAME, sizeof(UTUN_CONTROL_NAME));
    if (device_ioctl(fd, CTLIOCGINFO, &control) || !control.ctl_id) {
        int saved = errno; close_owned(fd);
        return finish(error, RELAY_TUN_DEVICE_SYSTEM, RELAY_TUN_STAGE_CONTROL, saved, false);
    }
    struct sockaddr_ctl requested_address = {.sc_len = sizeof(struct sockaddr_ctl),
        .sc_family = AF_SYSTEM, .ss_sysaddr = AF_SYS_CONTROL, .sc_id = control.ctl_id, .sc_unit = unit};
    COUNT(connect_calls);
    if (connect(fd, (struct sockaddr *)&requested_address, sizeof(requested_address))) {
        const int saved = errno;
        const RelayTunDeviceError cause = {saved == EBUSY || saved == EADDRINUSE ? RELAY_TUN_DEVICE_EXISTS : RELAY_TUN_DEVICE_SYSTEM,
            RELAY_TUN_STAGE_CONNECT, saved, true};
        return close_failed_creation(fd, cause, error);
    }
    RelayTunDevice *device = calloc(1, sizeof(*device));
    if (!device) {
        const RelayTunDeviceError cause = {RELAY_TUN_DEVICE_SYSTEM, RELAY_TUN_STAGE_OBSERVE, ENOMEM, true};
        return close_failed_creation(fd, cause, error);
    }
    struct sockaddr_ctl address; struct stat identity;
    RelayTunDeviceError observation;
    RelayTunDeviceCode result = observe_fd(fd, device->name, &address, &device->index, &identity, &observation);
    if (result != RELAY_TUN_DEVICE_OK) {
        result = close_failed_creation(fd, observation, error); free(device); return result;
    }
    if (address.sc_id != control.ctl_id || (unit && (address.sc_unit != unit || strcmp(device->name, requested)))) {
        const RelayTunDeviceError cause = {RELAY_TUN_DEVICE_IDENTITY, RELAY_TUN_STAGE_OBSERVE, ESTALE, true};
        result = close_failed_creation(fd, cause, error); free(device); return result;
    }
    device->magic = RELAY_DEVICE_MAGIC; device->fd = fd;
    device->control_id = address.sc_id; device->control_unit = address.sc_unit;
    device->fd_device = identity.st_dev; device->fd_inode = identity.st_ino;
    *out = device;
    return ok(error);
}
static void interface_request(struct ifreq *request, const RelayTunDevice *device) {
    memset(request, 0, sizeof(*request)); memcpy(request->ifr_name, device->name, IFNAMSIZ);
}
static int control_socket(int family, RelayTunDeviceError *error) {
    int fd = device_socket(family, SOCK_DGRAM, 0);
    if (fd < 0) { finish(error, RELAY_TUN_DEVICE_SYSTEM, RELAY_TUN_STAGE_SOCKET, errno, false); return -1; }
    COUNT(fd_calls);
    if (fcntl(fd, F_SETFD, FD_CLOEXEC)) {
        int saved = errno; close_owned(fd);
        finish(error, RELAY_TUN_DEVICE_SYSTEM, RELAY_TUN_STAGE_FD_FLAGS, saved, false); return -1;
    }
    return fd;
}
RelayTunDeviceCode relay_tun_device_snapshot(RelayTunDevice *device, RelayTunDeviceSnapshot *out,
                                           RelayTunDeviceError *error) {
    if (!privileged(error)) return RELAY_TUN_DEVICE_PERMISSION;
    if (!out) return finish(error, RELAY_TUN_DEVICE_INVALID, RELAY_TUN_STAGE_INPUT, EINVAL, false);
    RelayTunDeviceCode result = revalidate(device, error);
    if (result != RELAY_TUN_DEVICE_OK) return result;
    int fd = control_socket(AF_INET, error);
    if (fd < 0) return RELAY_TUN_DEVICE_SYSTEM;
    struct ifreq request; interface_request(&request, device);
    int code = device_ioctl(fd, SIOCGIFMTU, &request), saved = errno;
    int closed = close_owned(fd), close_error = errno;
    if (code || request.ifr_mtu <= 0)
        return finish(error, RELAY_TUN_DEVICE_SYSTEM, RELAY_TUN_STAGE_OBSERVE, code ? saved : EINVAL, false);
    if (closed) return finish(error, RELAY_TUN_DEVICE_SYSTEM, RELAY_TUN_STAGE_CLOSE, close_error, false);
    result = revalidate(device, error);
    if (result != RELAY_TUN_DEVICE_OK) return result;
    RelayTunDeviceSnapshot snapshot = {.interface_index = device->index, .control_id = device->control_id,
        .control_unit = device->control_unit, .mtu = (uint32_t)request.ifr_mtu};
    memcpy(snapshot.name, device->name, IFNAMSIZ); *out = snapshot;
    return ok(error);
}
RelayTunDeviceCode relay_tun_device_set_mtu(RelayTunDevice *device, uint32_t mtu,
                                          RelayTunDeviceError *error) {
    if (!privileged(error)) return RELAY_TUN_DEVICE_PERMISSION;
    RelayTunDeviceCode result = relay_tun_device_validate_mtu(mtu, error);
    if (result != RELAY_TUN_DEVICE_OK || (result = revalidate(device, error)) != RELAY_TUN_DEVICE_OK) return result;
    int fd = control_socket(AF_INET, error);
    if (fd < 0) return RELAY_TUN_DEVICE_SYSTEM;
    struct ifreq request; interface_request(&request, device); request.ifr_mtu = (int)mtu;
    result = revalidate(device, error);
    if (result != RELAY_TUN_DEVICE_OK) { close_owned(fd); return result; }
    int code = device_ioctl(fd, SIOCSIFMTU, &request), saved = errno;
    int closed = close_owned(fd), close_error = errno;
    if (code) return finish(error, RELAY_TUN_DEVICE_SYSTEM, RELAY_TUN_STAGE_MTU, saved, true);
    if (closed) return finish(error, RELAY_TUN_DEVICE_SYSTEM, RELAY_TUN_STAGE_CLOSE, close_error, true);
    RelayTunDeviceSnapshot snapshot;
    if (relay_tun_device_snapshot(device, &snapshot, error) != RELAY_TUN_DEVICE_OK || snapshot.mtu != mtu)
        return finish(error, RELAY_TUN_DEVICE_IDENTITY, RELAY_TUN_STAGE_MTU, ESTALE, true);
    return ok(error);
}
static bool address_present(RelayTunDevice *device, const RelayTunDevicePrefix *prefix) {
    struct ifaddrs *addresses = NULL;
    COUNT(observe_calls);
    if (getifaddrs(&addresses)) return false;
    bool found = false;
    for (struct ifaddrs *entry = addresses; entry; entry = entry->ifa_next) {
        if (!entry->ifa_name || strcmp(entry->ifa_name, device->name) || !entry->ifa_addr ||
            !entry->ifa_netmask || entry->ifa_addr->sa_family != prefix->family) continue;
        if (prefix->family == AF_INET) {
            const struct sockaddr_in *address = (const struct sockaddr_in *)entry->ifa_addr;
            const struct sockaddr_in *mask = (const struct sockaddr_in *)entry->ifa_netmask;
            found = !memcmp(&address->sin_addr, prefix->address, 4) && !memcmp(&mask->sin_addr, prefix->mask, 4);
        } else {
            const struct sockaddr_in6 *address = (const struct sockaddr_in6 *)entry->ifa_addr;
            const struct sockaddr_in6 *mask = (const struct sockaddr_in6 *)entry->ifa_netmask;
            found = !memcmp(&address->sin6_addr, prefix->address, 16) && !memcmp(&mask->sin6_addr, prefix->mask, 16);
        }
        if (found) break;
    }
    freeifaddrs(addresses);
    return found;
}
RelayTunDeviceCode relay_tun_device_add_ipv4(RelayTunDevice *device,
                                           const RelayTunDevicePrefix *prefix,
                                           RelayTunDeviceError *error) {
    if (!privileged(error)) return RELAY_TUN_DEVICE_PERMISSION;
    if (!valid_prefix(prefix, AF_INET)) return finish(error, RELAY_TUN_DEVICE_INVALID, RELAY_TUN_STAGE_INPUT, EINVAL, false);
    RelayTunDeviceCode result = revalidate(device, error);
    if (result != RELAY_TUN_DEVICE_OK) return result;
    struct ifaliasreq request = {0}; memcpy(request.ifra_name, device->name, IFNAMSIZ);
    struct sockaddr_in address = {.sin_len = sizeof(struct sockaddr_in), .sin_family = AF_INET}, mask = address;
    memcpy(&address.sin_addr, prefix->address, 4); memcpy(&mask.sin_addr, prefix->mask, 4);
    memcpy(&request.ifra_addr, &address, sizeof(address));
    memcpy(&request.ifra_broadaddr, &address, sizeof(address));
    memcpy(&request.ifra_mask, &mask, sizeof(mask));
    int fd = control_socket(AF_INET, error);
    if (fd < 0) return RELAY_TUN_DEVICE_SYSTEM;
    result = revalidate(device, error);
    if (result != RELAY_TUN_DEVICE_OK) { close_owned(fd); return result; }
    int code = device_ioctl(fd, SIOCAIFADDR, &request), saved = errno;
    int closed = close_owned(fd), close_error = errno;
    if (code) return finish(error, RELAY_TUN_DEVICE_SYSTEM, RELAY_TUN_STAGE_IPV4, saved, true);
    if (closed) return finish(error, RELAY_TUN_DEVICE_SYSTEM, RELAY_TUN_STAGE_CLOSE, close_error, true);
    if (revalidate(device, error) != RELAY_TUN_DEVICE_OK || !address_present(device, prefix))
        return finish(error, RELAY_TUN_DEVICE_IDENTITY, RELAY_TUN_STAGE_IPV4, ESTALE, true);
    return ok(error);
}
RelayTunDeviceCode relay_tun_device_add_ipv6(RelayTunDevice *device,
                                           const RelayTunDevicePrefix *prefix,
                                           RelayTunDeviceError *error) {
    if (!privileged(error)) return RELAY_TUN_DEVICE_PERMISSION;
    uint8_t destination[16];
    RelayTunDeviceCode result = relay_tun_device_ipv6_destination(prefix, destination, error);
    if (result != RELAY_TUN_DEVICE_OK || (result = revalidate(device, error)) != RELAY_TUN_DEVICE_OK) return result;
    struct in6_aliasreq request = {0}; memcpy(request.ifra_name, device->name, IFNAMSIZ);
    request.ifra_addr.sin6_len = sizeof(struct sockaddr_in6); request.ifra_addr.sin6_family = AF_INET6;
    request.ifra_prefixmask.sin6_len = sizeof(struct sockaddr_in6); request.ifra_prefixmask.sin6_family = AF_INET6;
    memcpy(&request.ifra_addr.sin6_addr, prefix->address, 16);
    memcpy(&request.ifra_prefixmask.sin6_addr, prefix->mask, 16);
    if (IN6_IS_ADDR_LINKLOCAL(&request.ifra_addr.sin6_addr)) request.ifra_addr.sin6_scope_id = device->index;
    if (prefix->prefix == 128) {
        request.ifra_dstaddr.sin6_len = sizeof(struct sockaddr_in6); request.ifra_dstaddr.sin6_family = AF_INET6;
        memcpy(&request.ifra_dstaddr.sin6_addr, destination, 16);
        if (IN6_IS_ADDR_LINKLOCAL(&request.ifra_dstaddr.sin6_addr)) request.ifra_dstaddr.sin6_scope_id = device->index;
    }
    request.ifra_flags = IN6_IFF_NODAD | IN6_IFF_SECURED;
    request.ifra_lifetime.ia6t_vltime = ND6_INFINITE_LIFETIME;
    request.ifra_lifetime.ia6t_pltime = ND6_INFINITE_LIFETIME;
    int fd = control_socket(AF_INET6, error);
    if (fd < 0) return RELAY_TUN_DEVICE_SYSTEM;
    result = revalidate(device, error);
    if (result != RELAY_TUN_DEVICE_OK) { close_owned(fd); return result; }
    int code = device_ioctl(fd, SIOCAIFADDR_IN6, &request), saved = errno;
    int closed = close_owned(fd), close_error = errno;
    if (code) return finish(error, RELAY_TUN_DEVICE_SYSTEM, RELAY_TUN_STAGE_IPV6, saved, true);
    if (closed) return finish(error, RELAY_TUN_DEVICE_SYSTEM, RELAY_TUN_STAGE_CLOSE, close_error, true);
    if (revalidate(device, error) != RELAY_TUN_DEVICE_OK || !address_present(device, prefix))
        return finish(error, RELAY_TUN_DEVICE_IDENTITY, RELAY_TUN_STAGE_IPV6, ESTALE, true);
    return ok(error);
}
RelayTunDeviceCode relay_tun_device_duplicate_fd(RelayTunDevice *device, int *out,
                                               RelayTunDeviceError *error) {
    if (!privileged(error)) return RELAY_TUN_DEVICE_PERMISSION;
    if (!out) return finish(error, RELAY_TUN_DEVICE_INVALID, RELAY_TUN_STAGE_INPUT, EINVAL, false);
    RelayTunDeviceCode result = revalidate(device, error);
    if (result != RELAY_TUN_DEVICE_OK) return result;
    COUNT(fd_calls);
    int fd = fcntl(device->fd, F_DUPFD_CLOEXEC, 3);
    if (fd < 0) return finish(error, RELAY_TUN_DEVICE_SYSTEM, RELAY_TUN_STAGE_DUPLICATE, errno, false);
    char name[IFNAMSIZ]; struct sockaddr_ctl address; struct stat identity; unsigned int index;
    if (observe_fd(fd, name, &address, &index, &identity, error) != RELAY_TUN_DEVICE_OK ||
        strcmp(name, device->name) || index != device->index || address.sc_id != device->control_id ||
        address.sc_unit != device->control_unit || identity.st_dev != device->fd_device || identity.st_ino != device->fd_inode) {
        close_owned(fd);
        return finish(error, RELAY_TUN_DEVICE_IDENTITY, RELAY_TUN_STAGE_DUPLICATE, ESTALE, false);
    }
    *out = fd;
    return ok(error);
}
RelayTunDeviceCode relay_tun_device_close(RelayTunDevice **pointer, RelayTunDeviceError *error) {
    if (!privileged(error)) return RELAY_TUN_DEVICE_PERMISSION;
    if (!pointer) return finish(error, RELAY_TUN_DEVICE_INVALID, RELAY_TUN_STAGE_INPUT, EINVAL, false);
    if (!*pointer) return ok(error);
    RelayTunDevice *device = *pointer;
    RelayTunDeviceCode result = revalidate(device, error);
    if (result != RELAY_TUN_DEVICE_OK) return result;
    COUNT(close_calls);
    int code = close(device->fd), saved = errno;
    device->fd = -1; device->magic = 0; free(device); *pointer = NULL;
    return code ? finish(error, RELAY_TUN_DEVICE_SYSTEM, RELAY_TUN_STAGE_CLOSE, saved, true) : ok(error);
}
