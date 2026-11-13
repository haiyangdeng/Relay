#include "RelayTunRouteCodec.h"

#include <limits.h>
#include <net/if_dl.h>
#include <net/route.h>
#include <netinet/in.h>
#include <string.h>

_Static_assert(offsetof(struct sockaddr_dl, sdl_data) + IFNAMSIZ <= sizeof(struct sockaddr_in6), "link encoding bound");
_Static_assert(sizeof(struct rt_msghdr) + 4 * (sizeof(struct sockaddr_in6) + 3) <= RELAY_TUN_ROUTE_MAX_MESSAGE, "message encoding bound");

static const uint32_t supported_flags = RTF_UP | RTF_GATEWAY | RTF_HOST | RTF_REJECT |
    RTF_STATIC | RTF_BLACKHOLE | RTF_IFSCOPE;

static bool zeros(const uint8_t *bytes, size_t length) {
    for (size_t i = 0; i < length; ++i) if (bytes[i] != 0) return false;
    return true;
}

static size_t address_size(int32_t family) { return family == AF_INET ? 4 : 16; }
static size_t address_offset(int32_t family) {
    return family == AF_INET ? offsetof(struct sockaddr_in, sin_addr) : offsetof(struct sockaddr_in6, sin6_addr);
}
static size_t sockaddr_size(int32_t family) {
    return family == AF_INET ? sizeof(struct sockaddr_in) : sizeof(struct sockaddr_in6);
}
static size_t aligned(size_t length) { return length == 0 ? 4 : (length + 3) & ~(size_t)3; }
static bool name_length(const char name[IFNAMSIZ], size_t *length) {
    for (size_t i = 0; i < IFNAMSIZ; ++i) {
        const unsigned char c = (unsigned char)name[i];
        if (c == 0) { *length = i; return true; }
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.')) return false;
    }
    return false;
}
static bool requires_zone(int32_t family, const uint8_t value[16]) {
    const uint8_t scope = value[1] & 0x0f, flags = value[1] & 0xf0;
    /* Match XNU in6.h IN6_IS_SCOPE_EMBED, including its exclusion for
     * unicast-prefix-based link-local multicast (flags 0x30). Reserved scope0
     * and those multicast address bytes are never erased as zone metadata. */
    return family == AF_INET6 &&
        ((value[0] == 0xfe && (value[1] & 0xc0) == 0x80) ||
         (value[0] == 0xff && (scope == 1 || (scope == 2 && flags != 0x30))));
}
static bool embedded_zone(int32_t family, const uint8_t value[16]) {
    return requires_zone(family, value) && (value[2] != 0 || value[3] != 0);
}

RelayTunRouteCode relay_tun_route_validate(const RelayTunRouteRecord *route) {
    size_t name = 0;
    if (route == NULL || (route->family != AF_INET && route->family != AF_INET6) ||
        route->interface_index == 0 || route->interface_index > UINT16_MAX ||
        !name_length(route->interface_name, &name)) return RELAY_TUN_ROUTE_INVALID;
    const size_t count = address_size(route->family);
    if (route->prefix > count * 8 || !zeros(route->destination + count, 16 - count) ||
        !zeros(route->gateway + count, 16 - count)) return RELAY_TUN_ROUTE_INVALID;
    for (size_t i = 0; i < count; ++i) {
        const size_t offset = i * 8;
        const unsigned bits = route->prefix <= offset ? 0 :
            route->prefix >= offset + 8 ? 8 : (unsigned)(route->prefix - offset);
        if ((route->destination[i] & (uint8_t)(0xffu >> bits)) != 0) return RELAY_TUN_ROUTE_INVALID;
    }
    if ((route->flags & ~supported_flags) != 0 ||
        ((route->flags & RTF_HOST) != 0 && route->prefix != count * 8) ||
        ((route->flags & RTF_REJECT) != 0 && (route->flags & RTF_BLACKHOLE) != 0) ||
        ((route->flags & RTF_IFSCOPE) != 0 ? route->scope_index != route->interface_index : route->scope_index != 0) ||
        embedded_zone(route->family, route->destination)) return RELAY_TUN_ROUTE_UNSUPPORTED;
    if (route->gateway_kind == RELAY_TUN_ROUTE_INTERFACE) {
        if ((route->flags & RTF_GATEWAY) != 0 || !zeros(route->gateway, 16)) return RELAY_TUN_ROUTE_UNSUPPORTED;
    } else if (route->gateway_kind == RELAY_TUN_ROUTE_IP) {
        if ((route->flags & RTF_GATEWAY) == 0 || requires_zone(route->family, route->gateway)) return RELAY_TUN_ROUTE_UNSUPPORTED;
    } else return RELAY_TUN_ROUTE_UNSUPPORTED;
    return RELAY_TUN_ROUTE_OK;
}

static size_t put_ip(uint8_t *out, int32_t family, const uint8_t address[16]) {
    const size_t length = sockaddr_size(family);
    memset(out, 0, aligned(length)); out[0] = (uint8_t)length; out[1] = (uint8_t)family;
    memcpy(out + address_offset(family), address, address_size(family)); return aligned(length);
}
static size_t put_link(uint8_t *out, const RelayTunRouteRecord *route) {
    size_t name = 0; (void)name_length(route->interface_name, &name);
    const size_t length = offsetof(struct sockaddr_dl, sdl_data) + name;
    memset(out, 0, aligned(length));
    struct sockaddr_dl link; memset(&link, 0, sizeof(link));
    link.sdl_len = (uint8_t)length; link.sdl_family = AF_LINK;
    link.sdl_index = (uint16_t)route->interface_index; link.sdl_type = route->interface_type;
    link.sdl_nlen = (uint8_t)name;
    memcpy(out, &link, offsetof(struct sockaddr_dl, sdl_data));
    memcpy(out + offsetof(struct sockaddr_dl, sdl_data), route->interface_name, name);
    return aligned(length);
}
RelayTunRouteCode relay_tun_route_encode(const RelayTunRouteRecord *route,
                                       uint8_t operation, int32_t pid, int32_t sequence,
                                       void *output, size_t capacity, size_t *written) {
    if (output == NULL || written == NULL || pid < 0 || sequence < 0) return RELAY_TUN_ROUTE_INVALID;
    if (operation != RTM_ADD && operation != RTM_GET) return RELAY_TUN_ROUTE_UNSUPPORTED;
    const RelayTunRouteCode valid = relay_tun_route_validate(route);
    if (valid != RELAY_TUN_ROUTE_OK) return valid;
    uint8_t bytes[RELAY_TUN_ROUTE_MAX_MESSAGE]; memset(bytes, 0, sizeof(bytes));
    size_t position = sizeof(struct rt_msghdr);
    position += put_ip(bytes + position, route->family, route->destination);
    position += route->gateway_kind == RELAY_TUN_ROUTE_IP ?
        put_ip(bytes + position, route->family, route->gateway) : put_link(bytes + position, route);
    uint8_t mask[16] = {0};
    for (size_t i = 0; i < address_size(route->family); ++i) {
        const size_t offset = i * 8;
        const unsigned bits = route->prefix <= offset ? 0 :
            route->prefix >= offset + 8 ? 8 : (unsigned)(route->prefix - offset);
        mask[i] = (uint8_t)(0xffu << (8 - bits));
    }
    position += put_ip(bytes + position, route->family, mask);
    if (route->gateway_kind == RELAY_TUN_ROUTE_IP) position += put_link(bytes + position, route);
    if (position > capacity) return RELAY_TUN_ROUTE_NO_SPACE;
    struct rt_msghdr header; memset(&header, 0, sizeof(header));
    header.rtm_msglen = (uint16_t)position; header.rtm_version = RTM_VERSION; header.rtm_type = operation;
    header.rtm_index = (uint16_t)route->interface_index; header.rtm_flags = (int)route->flags;
    header.rtm_addrs = RTA_DST | RTA_GATEWAY | RTA_NETMASK;
    if (route->gateway_kind == RELAY_TUN_ROUTE_IP) header.rtm_addrs |= RTA_IFP;
    header.rtm_pid = pid; header.rtm_seq = sequence;
    header.rtm_inits = RTV_HOPCOUNT; header.rtm_rmx.rmx_hopcount = route->hop_count;
    memcpy(bytes, &header, sizeof(header)); memcpy(output, bytes, position); *written = position;
    return RELAY_TUN_ROUTE_OK;
}

typedef struct { const uint8_t *bytes; size_t length; } AddressView;
static RelayTunRouteCode read_ip(AddressView value, int32_t family, uint8_t out[16]) {
    if (value.length != sockaddr_size(family) || value.bytes[1] != family) return RELAY_TUN_ROUTE_UNSUPPORTED;
    const size_t offset = address_offset(family), count = address_size(family);
    if (!zeros(value.bytes + 2, offset - 2) || !zeros(value.bytes + offset + count, value.length - offset - count)) return RELAY_TUN_ROUTE_UNSUPPORTED;
    memcpy(out, value.bytes + offset, count);
    return embedded_zone(family, out) ? RELAY_TUN_ROUTE_UNSUPPORTED : RELAY_TUN_ROUTE_OK;
}
static RelayTunRouteCode read_destination(AddressView value, int32_t family, uint8_t out[16], uint32_t *zone) {
    if (family == AF_INET) return read_ip(value, family, out);
    const size_t offset = offsetof(struct sockaddr_in6, sin6_addr);
    if (value.length != sizeof(struct sockaddr_in6) || value.bytes[1] != AF_INET6 ||
        !zeros(value.bytes + 2, offset - 2)) return RELAY_TUN_ROUTE_UNSUPPORTED;
    memcpy(out, value.bytes + offset, 16);
    uint32_t explicit_zone = 0;
    memcpy(&explicit_zone, value.bytes + offsetof(struct sockaddr_in6, sin6_scope_id), sizeof(explicit_zone));
    if (!requires_zone(family, out)) return explicit_zone == 0 ? RELAY_TUN_ROUTE_OK : RELAY_TUN_ROUTE_UNSUPPORTED;
    /* XNU scope6.c sa6_embedscope/sa6_recoverscope stores the recognized
     * zone in s6_addr16[1] (network order), whereas sin6_scope_id is native
     * UInt32. A loopback route can legitimately name another interface zone. */
    const uint32_t embedded = ((uint32_t)out[2] << 8) | out[3];
    if (embedded != 0 && explicit_zone != 0 && embedded != explicit_zone) return RELAY_TUN_ROUTE_UNSUPPORTED;
    *zone = explicit_zone != 0 ? explicit_zone : embedded;
    out[2] = 0; out[3] = 0;
    return RELAY_TUN_ROUTE_OK;
}
static RelayTunRouteCode read_link(AddressView value, uint32_t index, char name[IFNAMSIZ], uint8_t *type) {
    const size_t base = offsetof(struct sockaddr_dl, sdl_data);
    if (value.length < base || value.bytes[1] != AF_LINK) return RELAY_TUN_ROUTE_UNSUPPORTED;
    struct sockaddr_dl link; memset(&link, 0, sizeof(link)); memcpy(&link, value.bytes, base);
    if (link.sdl_index != index || link.sdl_alen != 0 || link.sdl_slen != 0 || link.sdl_nlen >= IFNAMSIZ ||
        base + link.sdl_nlen > value.length || !zeros(value.bytes + base + link.sdl_nlen, value.length - base - link.sdl_nlen)) return RELAY_TUN_ROUTE_UNSUPPORTED;
    memcpy(name, value.bytes + base, link.sdl_nlen); name[link.sdl_nlen] = 0;
    size_t count = 0;
    if (!name_length(name, &count) || count != link.sdl_nlen) return RELAY_TUN_ROUTE_UNSUPPORTED;
    *type = link.sdl_type; return RELAY_TUN_ROUTE_OK;
}
static RelayTunRouteCode read_mask(AddressView value, int32_t family, uint8_t *prefix) {
    uint8_t mask[16] = {0}; const size_t offset = address_offset(family), count = address_size(family);
    if (value.length == 0) { *prefix = 0; return RELAY_TUN_ROUTE_OK; }
    if (value.length < 2 || value.length > sockaddr_size(family)) return RELAY_TUN_ROUTE_UNSUPPORTED;
    /* XNU xnu-11417.140.69 bsd/net/radix.c rn_addmask (573-595)
     * fills bytes [1, skip) with FF and trims trailing zeroes. The IPv4
     * dom_rtoffset is 32 (in_proto.c:280), IPv6 uses sin6_addr<<3
     * (in6_proto.c:343). NET_RT_DUMP exports this rt_mask via rtsock.c.
     * Therefore this exact FF header is a radix mask, not an IP family,
     * port or flowinfo. Do not permit arbitrary skipped/mixed bytes. */
    const bool radix = value.bytes[1] == UINT8_MAX;
    if (radix) {
        if (value.length <= offset || value.length > offset + count || value.bytes[value.length - 1] == 0) return RELAY_TUN_ROUTE_UNSUPPORTED;
        for (size_t i = 1; i < offset; ++i) if (value.bytes[i] != UINT8_MAX) return RELAY_TUN_ROUTE_UNSUPPORTED;
    } else if (value.bytes[1] != AF_UNSPEC && value.bytes[1] != family) return RELAY_TUN_ROUTE_UNSUPPORTED;
    for (size_t i = 2; i < value.length; ++i) {
        if (i >= offset && i < offset + count) mask[i - offset] = value.bytes[i];
        else if (!(radix && i < offset) && value.bytes[i] != 0) return RELAY_TUN_ROUTE_UNSUPPORTED;
    }
    unsigned bits = 0; bool ended = false;
    for (size_t i = 0; i < count; ++i) for (unsigned bit = 0; bit < 8; ++bit) {
        const bool set = (mask[i] & (uint8_t)(0x80u >> bit)) != 0;
        if (set && ended) return RELAY_TUN_ROUTE_UNSUPPORTED;
        if (set) ++bits; else ended = true;
    }
    *prefix = (uint8_t)bits; return RELAY_TUN_ROUTE_OK;
}
static bool unsupported_metrics(const struct rt_msghdr *header, bool kernel_observation) {
    const struct rt_metrics *m = &header->rtm_rmx;
    return (header->rtm_inits & ~RTV_HOPCOUNT) != 0 || m->rmx_locks != 0 || (!kernel_observation && m->rmx_mtu != 0) || m->rmx_expire != 0 ||
        m->rmx_recvpipe != 0 || m->rmx_sendpipe != 0 || m->rmx_ssthresh != 0 || m->rmx_rtt != 0 || m->rmx_rttvar != 0 ||
        !zeros((const uint8_t *)m->rmx_filler, sizeof(m->rmx_filler));
}
static RelayTunRouteCode read_frame(const void *bytes, size_t length, struct rt_msghdr *header, AddressView addresses[RTAX_MAX]) {
    if (bytes == NULL || length < sizeof(*header) || length > UINT16_MAX) return RELAY_TUN_ROUTE_INVALID;
    memcpy(header, bytes, sizeof(*header));
    if (header->rtm_msglen != length || header->rtm_version != RTM_VERSION) return RELAY_TUN_ROUTE_INVALID;
    if (header->rtm_type != RTM_ADD && header->rtm_type != RTM_GET) return RELAY_TUN_ROUTE_UNSUPPORTED;
    if (header->rtm_errno != 0) return RELAY_TUN_ROUTE_KERNEL_ERROR;
    if (header->rtm_pid < 0 || header->rtm_seq < 0) return RELAY_TUN_ROUTE_INVALID;
    if (((uint32_t)header->rtm_addrs & ~((1u << RTAX_MAX) - 1)) != 0) return RELAY_TUN_ROUTE_UNSUPPORTED;
    memset(addresses, 0, sizeof(AddressView) * RTAX_MAX);
    size_t position = sizeof(*header); const uint8_t *raw = bytes;
    for (unsigned i = 0; i < RTAX_MAX; ++i) if (((uint32_t)header->rtm_addrs & (1u << i)) != 0) {
        if (length - position < 2) return RELAY_TUN_ROUTE_INVALID;
        const size_t size = raw[position], span = aligned(size);
        if ((size == 0 && i != RTAX_NETMASK) || size == 1 || span > length - position) return RELAY_TUN_ROUTE_INVALID;
        addresses[i] = (AddressView){raw + position, size}; position += span;
    }
    if (position != length) return RELAY_TUN_ROUTE_INVALID;
    return RELAY_TUN_ROUTE_OK;
}
static RelayTunRouteCode read_key(const struct rt_msghdr *header, const AddressView addresses[RTAX_MAX], RelayTunRouteKey *key) {
    if ((header->rtm_addrs & RTA_DST) == 0) return RELAY_TUN_ROUTE_UNSUPPORTED;
    key->family = addresses[RTAX_DST].bytes[1];
    if (key->family != AF_INET && key->family != AF_INET6) return RELAY_TUN_ROUTE_UNSUPPORTED;
    RelayTunRouteCode code = read_destination(addresses[RTAX_DST], key->family, key->destination, &key->zone_index);
    if (code != RELAY_TUN_ROUTE_OK) return code;
    if ((header->rtm_addrs & RTA_NETMASK) != 0) {
        code = read_mask(addresses[RTAX_NETMASK], key->family, &key->prefix);
        if (code != RELAY_TUN_ROUTE_OK) return code;
    } else if ((header->rtm_flags & RTF_HOST) != 0) key->prefix = (uint8_t)(address_size(key->family) * 8);
    else return RELAY_TUN_ROUTE_UNSUPPORTED;
    const size_t count = address_size(key->family);
    if ((header->rtm_flags & RTF_HOST) != 0 && key->prefix != count * 8) return RELAY_TUN_ROUTE_UNSUPPORTED;
    for (size_t i = 0; i < count; ++i) {
        const size_t offset = i * 8;
        const unsigned bits = key->prefix <= offset ? 0 : key->prefix >= offset + 8 ? 8 : (unsigned)(key->prefix - offset);
        if ((key->destination[i] & (uint8_t)(0xffu >> bits)) != 0) return RELAY_TUN_ROUTE_INVALID;
    }
    key->scope_index = (header->rtm_flags & RTF_IFSCOPE) != 0 ? header->rtm_index : 0;
    if ((header->rtm_flags & RTF_IFSCOPE) != 0 && key->scope_index == 0) return RELAY_TUN_ROUTE_UNSUPPORTED;
    return RELAY_TUN_ROUTE_OK;
}
RelayTunRouteCode relay_tun_route_key_decode(const void *bytes, size_t length, RelayTunRouteKey *output) {
    if (output == NULL) return RELAY_TUN_ROUTE_INVALID;
    struct rt_msghdr header; AddressView addresses[RTAX_MAX];
    RelayTunRouteCode code = read_frame(bytes, length, &header, addresses);
    if (code != RELAY_TUN_ROUTE_OK) return code;
    if (header.rtm_type != RTM_GET) return RELAY_TUN_ROUTE_UNSUPPORTED;
    RelayTunRouteKey key; memset(&key, 0, sizeof(key));
    code = read_key(&header, addresses, &key); if (code != RELAY_TUN_ROUTE_OK) return code;
    *output = key; return RELAY_TUN_ROUTE_OK;
}
RelayTunRouteCode relay_tun_route_decode(const void *bytes, size_t length, RelayTunRouteMessage *output) {
    if (output == NULL) return RELAY_TUN_ROUTE_INVALID;
    struct rt_msghdr header; AddressView addresses[RTAX_MAX];
    RelayTunRouteCode code = read_frame(bytes, length, &header, addresses);
    if (code != RELAY_TUN_ROUTE_OK) return code;
    const uint32_t flags = (uint32_t)header.rtm_flags;
    const bool kernel_observation = header.rtm_type == RTM_GET || (flags & RTF_DONE) != 0;
    const uint32_t observed_flags = kernel_observation ? RTF_PRCLONING : 0;
    const int observed_addresses = kernel_observation ? RTA_IFA : 0;
    if ((flags & ~(supported_flags | RTF_DONE | observed_flags)) != 0 || unsupported_metrics(&header, kernel_observation) ||
        (header.rtm_addrs & ~(RTA_DST | RTA_GATEWAY | RTA_NETMASK | RTA_IFP | observed_addresses)) != 0 ||
        (header.rtm_addrs & (RTA_DST | RTA_GATEWAY)) != (RTA_DST | RTA_GATEWAY)) return RELAY_TUN_ROUTE_UNSUPPORTED;
    RelayTunRouteKey key; memset(&key, 0, sizeof(key));
    code = read_key(&header, addresses, &key); if (code != RELAY_TUN_ROUTE_OK) return code;
    if (key.zone_index != 0) return RELAY_TUN_ROUTE_UNSUPPORTED;
    RelayTunRouteMessage result; memset(&result, 0, sizeof(result));
    RelayTunRouteRecord *route = &result.route;
    route->family = key.family; route->prefix = key.prefix; memcpy(route->destination, key.destination, sizeof(route->destination));
    route->interface_index = header.rtm_index; route->flags = flags & ~(uint32_t)(RTF_DONE | RTF_PRCLONING);
    route->scope_index = key.scope_index;
    route->hop_count = header.rtm_rmx.rmx_hopcount;
    if (addresses[RTAX_GATEWAY].bytes[1] == AF_LINK) {
        route->gateway_kind = RELAY_TUN_ROUTE_INTERFACE;
        code = read_link(addresses[RTAX_GATEWAY], route->interface_index, route->interface_name, &route->interface_type);
    } else {
        route->gateway_kind = RELAY_TUN_ROUTE_IP;
        code = read_ip(addresses[RTAX_GATEWAY], route->family, route->gateway);
    }
    if (code != RELAY_TUN_ROUTE_OK) return code;
    if ((header.rtm_addrs & RTA_IFP) != 0) {
        char name[IFNAMSIZ] = {0}; uint8_t type = 0;
        code = read_link(addresses[RTAX_IFP], route->interface_index, name, &type);
        if (code != RELAY_TUN_ROUTE_OK) return code;
        if (route->gateway_kind == RELAY_TUN_ROUTE_INTERFACE &&
            (route->interface_type != type || (route->interface_name[0] != 0 && name[0] != 0 && strcmp(route->interface_name, name) != 0))) return RELAY_TUN_ROUTE_UNSUPPORTED;
        if (name[0] != 0) memcpy(route->interface_name, name, sizeof(name));
        route->interface_type = type;
    }
    code = relay_tun_route_validate(route); if (code != RELAY_TUN_ROUTE_OK) return code;
    result.kernel_protocol_cloning = (flags & RTF_PRCLONING) != 0;
    if (result.kernel_protocol_cloning &&
        (route->family != AF_INET || route->gateway_kind != RELAY_TUN_ROUTE_INTERFACE ||
         route->prefix == 0 || route->prefix >= 32 ||
         (route->flags & (RTF_GATEWAY | RTF_HOST | RTF_REJECT | RTF_BLACKHOLE)) != 0)) return RELAY_TUN_ROUTE_UNSUPPORTED;
    result.kernel_mtu = header.rtm_rmx.rmx_mtu;
    if ((header.rtm_addrs & RTA_IFA) != 0) {
        code = read_ip(addresses[RTAX_IFA], route->family, result.interface_address);
        if (code != RELAY_TUN_ROUTE_OK) return code;
        result.interface_address_family = route->family;
    }
    result.pid = header.rtm_pid; result.sequence = header.rtm_seq; result.operation = header.rtm_type;
    result.confirmed = (flags & RTF_DONE) != 0; *output = result;
    return RELAY_TUN_ROUTE_OK;
}
