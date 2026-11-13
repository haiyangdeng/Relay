#include "RelayTunRouteCodec.h"

#include <arpa/inet.h>
#include <errno.h>
#include <net/if_dl.h>
#include <net/route.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static unsigned checks = 0;
static void check(bool result, const char *name) {
    ++checks; if (!result) { fprintf(stderr, "FAIL: %s\n", name); exit(1); }
}
typedef struct { uint8_t bytes[1024]; size_t length; } Frame;
static Frame encode(RelayTunRouteRecord route) {
    Frame frame = {{0}, 0};
    check(relay_tun_route_encode(&route, RELAY_TUN_ROUTE_ADD, 41, 27, frame.bytes, sizeof(frame.bytes), &frame.length) == RELAY_TUN_ROUTE_OK, "encode typed fixture");
    return frame;
}
static struct rt_msghdr header(Frame frame) {
    struct rt_msghdr value; memcpy(&value, frame.bytes, sizeof(value)); return value;
}
static void set_header(Frame *frame, struct rt_msghdr value) { memcpy(frame->bytes, &value, sizeof(value)); }
static size_t span(uint8_t length) { return length == 0 ? 4 : ((size_t)length + 3) & ~(size_t)3; }
static size_t position(Frame frame, unsigned address) {
    struct rt_msghdr value = header(frame); size_t result = sizeof(value);
    for (unsigned i = 0; i < address; ++i) if ((value.rtm_addrs & (1u << i)) != 0) result += span(frame.bytes[result]);
    return result;
}
static void replace(Frame *frame, unsigned address, const uint8_t *value, size_t count, bool present) {
    struct rt_msghdr head = header(*frame); size_t offset = position(*frame, address);
    const bool existing = (head.rtm_addrs & (1u << address)) != 0;
    const size_t previous = existing ? span(frame->bytes[offset]) : 0;
    const size_t length = present ? (count == 0 ? 4 : (count + 3) & ~(size_t)3) : 0;
    memmove(frame->bytes + offset + length, frame->bytes + offset + previous, frame->length - offset - previous);
    memset(frame->bytes + offset, 0, length);
    if (present && count != 0) memcpy(frame->bytes + offset, value, count);
    frame->length = frame->length - previous + length;
    head.rtm_msglen = (uint16_t)frame->length;
    if (present) head.rtm_addrs |= (int)(1u << address); else head.rtm_addrs &= ~(int)(1u << address);
    set_header(frame, head);
}
static bool same_route(const RelayTunRouteRecord *a, const RelayTunRouteRecord *b) {
    return a->family == b->family && a->prefix == b->prefix && memcmp(a->destination, b->destination, 16) == 0 &&
        a->gateway_kind == b->gateway_kind && memcmp(a->gateway, b->gateway, 16) == 0 && a->interface_index == b->interface_index &&
        strcmp(a->interface_name, b->interface_name) == 0 && a->interface_type == b->interface_type &&
        a->scope_index == b->scope_index && a->flags == b->flags && a->hop_count == b->hop_count;
}
static RelayTunRouteRecord route(int family, bool gateway) {
    RelayTunRouteRecord value; memset(&value, 0, sizeof(value));
    value.family = family; value.prefix = family == AF_INET ? 24 : 48;
    value.gateway_kind = gateway ? RELAY_TUN_ROUTE_IP : RELAY_TUN_ROUTE_INTERFACE;
    value.interface_index = 49; strcpy(value.interface_name, "utun48"); value.interface_type = 1;
    value.flags = RTF_UP | RTF_STATIC | (gateway ? RTF_GATEWAY : 0); value.hop_count = UINT32_MAX;
    check(inet_pton(family, family == AF_INET ? "198.18.0.0" : "2001:db8:1234::", value.destination) == 1, "fixture destination");
    if (gateway) check(inet_pton(family, family == AF_INET ? "198.18.1.1" : "2001:db8::1", value.gateway) == 1, "fixture gateway");
    return value;
}
static RelayTunRouteMessage decode(Frame frame) {
    RelayTunRouteMessage value; memset(&value, 0, sizeof(value));
    check(relay_tun_route_decode(frame.bytes, frame.length, &value) == RELAY_TUN_ROUTE_OK, "decode fixture"); return value;
}
static void refuse(Frame frame, RelayTunRouteCode expected, const char *name) {
    RelayTunRouteMessage sentinel, result; memset(&sentinel, 0xa5, sizeof(sentinel)); result = sentinel;
    check(relay_tun_route_decode(frame.bytes, frame.length, &result) == expected, name);
    check(memcmp(&sentinel, &result, sizeof(result)) == 0, "refusal leaves output untouched");
}
static void round_trips(void) {
    for (unsigned family = 0; family < 2; ++family) for (unsigned gateway = 0; gateway < 2; ++gateway) {
        RelayTunRouteRecord original = route(family == 0 ? AF_INET : AF_INET6, gateway != 0);
        Frame frame = encode(original); RelayTunRouteMessage value = decode(frame);
        check(same_route(&value.route, &original), "lossless IPv4/IPv6 IP/interface route");
        check(value.pid == 41 && value.sequence == 27 && value.operation == RELAY_TUN_ROUTE_ADD && !value.confirmed, "request metadata retained");
        struct rt_msghdr head = header(frame); head.rtm_flags |= RTF_DONE; head.rtm_use = 37; head.rtm_rmx.rmx_pksent = 194;
        set_header(&frame, head); value = decode(frame);
        check(value.confirmed && same_route(&value.route, &original), "only ACK/counters normalize in accepted successful message");
        head.rtm_type = RTM_GET; set_header(&frame, head); value = decode(frame);
        check(value.operation == RELAY_TUN_ROUTE_GET && value.confirmed, "successful GET can carry DONE");
        original.interface_index = UINT16_MAX; original.scope_index = UINT16_MAX; original.flags |= RTF_IFSCOPE;
        frame = encode(original); value = decode(frame);
        check(same_route(&value.route, &original), "max16-bit index and explicit scope survive");
        original.interface_name[0] = 0; frame = encode(original); value = decode(frame);
        check(value.route.interface_name[0] == 0 && value.route.interface_index == UINT16_MAX, "index-only link identity does no external lookup");
    }
    RelayTunRouteRecord original = route(AF_INET, false);
    strcpy(original.interface_name, "long-name_12345"); check(strlen(original.interface_name) == 15, "maximum name fixture");
    Frame frame = encode(original); RelayTunRouteMessage value = decode(frame);
    check(same_route(&value.route, &original), "variable link sockaddr longer than SDK minimum work area");
    uint8_t unaligned[1025]; memcpy(unaligned + 1, frame.bytes, frame.length);
    check(relay_tun_route_decode(unaligned + 1, frame.length, &value) == RELAY_TUN_ROUTE_OK, "unaligned frame parsed through memcpy");
    frame = encode(original); size_t written = 0;
    check(relay_tun_route_encode(&original, RELAY_TUN_ROUTE_GET, 0, 0, frame.bytes, sizeof(frame.bytes), &written) == RELAY_TUN_ROUTE_OK && written == frame.length, "pure GET encoding accepted");
}
static void masks(void) {
    for (unsigned family = 0; family < 2; ++family) {
        RelayTunRouteRecord original = route(family == 0 ? AF_INET : AF_INET6, false);
        const size_t offset = family == 0 ? offsetof(struct sockaddr_in, sin_addr) : offsetof(struct sockaddr_in6, sin6_addr);
        Frame frame = encode(original); uint8_t compact[28] = {0};
        const size_t length = offset + original.prefix / 8;
        compact[0] = (uint8_t)length; memset(compact + offset, 0xff, original.prefix / 8);
        replace(&frame, RTAX_NETMASK, compact, length, true);
        RelayTunRouteMessage value = decode(frame); check(same_route(&value.route, &original), "short AF_UNSPEC compact netmask expands missing tail to zero");
        compact[offset] = 0xfd; replace(&frame, RTAX_NETMASK, compact, length, true);
        refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "noncontiguous masks refuse");
        memset(original.destination, 0, sizeof(original.destination)); original.prefix = 0; frame = encode(original);
        replace(&frame, RTAX_NETMASK, NULL, 0, true); value = decode(frame);
        check(same_route(&value.route, &original), "zero sa_len default mask consumes four bytes");
        uint8_t two[2] = {2, AF_UNSPEC}; replace(&frame, RTAX_NETMASK, two, sizeof(two), true); value = decode(frame);
        check(value.route.prefix == 0, "two-byte default mask accepted");
        original.prefix = family == 0 ? 32 : 128; original.flags |= RTF_HOST;
        frame = encode(original); replace(&frame, RTAX_NETMASK, NULL, 0, false); value = decode(frame);
        check(same_route(&value.route, &original), "absent mask only accepted for explicit host route");
        struct rt_msghdr head = header(frame); head.rtm_flags &= ~RTF_HOST; set_header(&frame, head);
        refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "missing network mask is not inferred");
        original.flags &= ~(uint32_t)RTF_HOST; frame = encode(original);
        size_t mask = position(frame, RTAX_NETMASK); frame.bytes[mask + 2] = 1;
        refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "mask port/flow fields are not ignored");
    }
}
static void radix_masks(void) {
    for (unsigned family = 0; family < 2; ++family) {
        RelayTunRouteRecord original = route(family == 0 ? AF_INET : AF_INET6, false);
        memset(original.destination, 0, sizeof(original.destination));
        const size_t offset = family == 0 ? offsetof(struct sockaddr_in, sin_addr) : offsetof(struct sockaddr_in6, sin6_addr);
        const unsigned maximum = family == 0 ? 32 : 128;
        for (unsigned prefix = 1; prefix <= maximum; ++prefix) {
            original.prefix = (uint8_t)prefix; Frame frame = encode(original);
            uint8_t mask[28] = {0}; const size_t length = offset + (prefix + 7) / 8;
            mask[0] = (uint8_t)length; memset(mask + 1, 0xff, offset - 1);
            for (size_t i = offset; i < length; ++i) {
                const unsigned remaining = prefix - (unsigned)(i - offset) * 8;
                mask[i] = remaining >= 8 ? 0xff : (uint8_t)(0xffu << (8 - remaining));
            }
            replace(&frame, RTAX_NETMASK, mask, length, true);
            RelayTunRouteMessage decoded = decode(frame);
            check(same_route(&decoded.route, &original), "XNU all-FF radix header and trimmed mask preserve every prefix");
            struct rt_msghdr head = header(frame); head.rtm_type = RTM_GET; set_header(&frame, head);
            RelayTunRouteKey key;
            check(relay_tun_route_key_decode(frame.bytes, frame.length, &key) == RELAY_TUN_ROUTE_OK && key.prefix == prefix, "radix mask also yields exact lookup-key prefix");
        }
        original.prefix = 8; Frame good = encode(original); uint8_t mask[28] = {0};
        const size_t length = offset + 1; mask[0] = (uint8_t)length;
        memset(mask + 1, 0xff, length - 1); replace(&good, RTAX_NETMASK, mask, length, true);
        for (size_t i = 1; i < offset; ++i) {
            Frame frame = good; size_t position_mask = position(frame, RTAX_NETMASK);
            frame.bytes[position_mask + i] = i == 1 ? (uint8_t)original.family : 0;
            refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "mixed canonical/radix skipped header refuses");
        }
        Frame frame = good; mask[length] = 0; mask[0] = (uint8_t)(length + 1);
        replace(&frame, RTAX_NETMASK, mask, length + 1, true);
        refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "radix mask must be exactly trimmed rather than retain trailing zeros");
        memset(mask, 0xff, sizeof(mask)); mask[0] = (uint8_t)sizeof(mask); frame = good;
        replace(&frame, RTAX_NETMASK, mask, sizeof(mask), true);
        refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "radix bytes beyond represented address never disappear");
        frame = good; mask[0] = (uint8_t)length; memset(mask + 1, 0xff, length - 1); mask[offset] = 0xfd;
        replace(&frame, RTAX_NETMASK, mask, length, true);
        refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "noncontiguous radix masks still refuse");
    }
}
static void malformed(void) {
    RelayTunRouteRecord original = route(AF_INET, false); Frame good = encode(original), frame = good;
    for (size_t length = 0; length < good.length; ++length) {
        frame = good; frame.length = length; refuse(frame, RELAY_TUN_ROUTE_INVALID, "every truncation refuses");
    }
    frame = good; ++frame.length; refuse(frame, RELAY_TUN_ROUTE_INVALID, "trailing bytes outside msglen refuse");
    frame = good; struct rt_msghdr head = header(frame); head.rtm_version = RTM_VERSION - 1; set_header(&frame, head);
    refuse(frame, RELAY_TUN_ROUTE_INVALID, "wrong version refuses");
    const uint8_t operations[] = {0, RTM_DELETE, RTM_CHANGE, RTM_GET2, RTM_IFINFO, UINT8_MAX};
    for (size_t i = 0; i < sizeof(operations); ++i) {
        frame = good; head = header(frame); head.rtm_type = operations[i]; head.rtm_flags |= RTF_DONE; set_header(&frame, head);
        refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "DONE never converts unsupported opcode to accepted reply");
    }
    frame = good; head = header(frame); head.rtm_errno = ESRCH; head.rtm_flags |= RTF_DONE; set_header(&frame, head);
    refuse(frame, RELAY_TUN_ROUTE_KERNEL_ERROR, "kernel ESRCH is an error, never absence");
    frame = good; head = header(frame); head.rtm_index = 0; set_header(&frame, head);
    refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "header/link interface mismatch refuses");
    frame = good; head = header(frame); head.rtm_flags |= (int)0x80000000u; set_header(&frame, head);
    refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "unknown high flag bit refuses without signed narrowing");
    const uint32_t flags[] = {RTF_LLINFO, RTF_CLONING, RTF_WASCLONED, RTF_IFREF, RTF_DELCLONE, RTF_CONDEMNED};
    for (size_t i = 0; i < sizeof(flags) / sizeof(flags[0]); ++i) {
        frame = good; head = header(frame); head.rtm_flags |= (int)flags[i]; set_header(&frame, head);
        refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "unrepresented route flags refuse");
    }
    frame = good; uint8_t author[16] = {16, AF_INET}; replace(&frame, RTAX_AUTHOR, author, sizeof(author), true);
    refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "unrepresented address refuses");
    frame = good; replace(&frame, RTAX_DST, NULL, 0, false);
    refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "missing destination refuses");
    frame = good; head = header(frame); head.rtm_addrs |= (int)0x80000000u; set_header(&frame, head);
    refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "high unknown address bit refuses");
    frame = good; head = header(frame); head.rtm_pid = -1; set_header(&frame, head);
    refuse(frame, RELAY_TUN_ROUTE_INVALID, "negative sender refuses");
    frame = good; head = header(frame); head.rtm_seq = -1; set_header(&frame, head);
    refuse(frame, RELAY_TUN_ROUTE_INVALID, "negative sequence refuses");
    for (unsigned i = 0; i < 3; ++i) {
        frame = good; size_t offset = position(frame, i); frame.bytes[offset] = UINT8_MAX;
        refuse(frame, RELAY_TUN_ROUTE_INVALID, "oversized sockaddr span refuses");
        frame = good; frame.bytes[offset] = 1; refuse(frame, RELAY_TUN_ROUTE_INVALID, "one-byte sockaddr refuses");
        if (i != RTAX_NETMASK) { frame = good; frame.bytes[offset] = 0; refuse(frame, RELAY_TUN_ROUTE_INVALID, "zero destination/gateway length refuses"); }
    }
    frame = good; size_t offset = position(frame, RTAX_DST); frame.bytes[offset + 1] = AF_UNSPEC;
    refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "unknown destination family refuses");
    frame = good; offset = position(frame, RTAX_DST); frame.bytes[offset + offsetof(struct sockaddr_in, sin_addr) + 3] = 1;
    refuse(frame, RELAY_TUN_ROUTE_INVALID, "unaligned destination refuses");
    frame = good; offset = position(frame, RTAX_GATEWAY); frame.bytes[offset + offsetof(struct sockaddr_dl, sdl_alen)] = 6;
    refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "AF_LINK MAC address refuses");
    frame = good; offset = position(frame, RTAX_GATEWAY); frame.bytes[offset + offsetof(struct sockaddr_dl, sdl_slen)] = 1;
    refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "AF_LINK selector refuses");
    frame = good; offset = position(frame, RTAX_GATEWAY); frame.bytes[offset + offsetof(struct sockaddr_dl, sdl_nlen)] = 15;
    refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "AF_LINK name cannot exceed sockaddr payload");
    frame = good; offset = position(frame, RTAX_GATEWAY); frame.bytes[offset + offsetof(struct sockaddr_dl, sdl_data)] = '/';
    refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "interface name invalid byte refuses");
}
static void metrics(void) {
    RelayTunRouteRecord original = route(AF_INET, false); const Frame good = encode(original);
    const size_t fields[] = {offsetof(struct rt_metrics, rmx_locks), offsetof(struct rt_metrics, rmx_mtu),
        offsetof(struct rt_metrics, rmx_expire), offsetof(struct rt_metrics, rmx_recvpipe), offsetof(struct rt_metrics, rmx_sendpipe),
        offsetof(struct rt_metrics, rmx_ssthresh), offsetof(struct rt_metrics, rmx_rtt), offsetof(struct rt_metrics, rmx_rttvar),
        offsetof(struct rt_metrics, rmx_filler), offsetof(struct rt_metrics, rmx_filler) + 12};
    for (size_t i = 0; i < sizeof(fields) / sizeof(fields[0]); ++i) {
        Frame frame = good; frame.bytes[offsetof(struct rt_msghdr, rtm_rmx) + fields[i]] = 1;
        refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "unrepresented metrics refuse");
    }
    Frame frame = good; struct rt_msghdr head = header(frame); head.rtm_inits |= RTV_MTU; set_header(&frame, head);
    refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "unrepresented metric-init bit refuses");
}
static void kernel_metadata(void) {
    /* Exact 148-byte NET_RT_DUMP frame from the owned 2026-10-28 utun4
     * route: UP|STATIC|PRCLONING, MTU1500, RTA_IFA 198.18.0.1. No live IO. */
    static const uint8_t captured[] = {
        0x94,0x00,0x05,0x04,0x14,0x00,0x00,0x00,0x01,0x08,0x01,0x00,
        0x27,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0xdc,0x05,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x10,0x02,0x00,0x00,
        0xc6,0x33,0x64,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x0d,0x12,0x14,0x00,0x01,0x05,0x00,0x00,0x75,0x74,0x75,0x6e,
        0x34,0x00,0x00,0x00,0x07,0xff,0xff,0xff,0xff,0xff,0xff,0x00,
        0x10,0x02,0x00,0x00,0xc6,0x12,0x00,0x01,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00
    };
    Frame good = {{0}, sizeof(captured)}; memcpy(good.bytes, captured, sizeof(captured));
    RelayTunRouteMessage value; memset(&value, 0, sizeof(value));
    check(relay_tun_route_decode(good.bytes, good.length, &value) == RELAY_TUN_ROUTE_OK,
        "actual owned Darwin route frame decodes without erasing kernel metadata");
    const uint8_t destination[16] = {198,51,100,0}, address[16] = {198,18,0,1}, empty[16] = {0};
    check(value.route.family == AF_INET && value.route.prefix == 24 &&
        memcmp(value.route.destination, destination, 16) == 0 && value.route.interface_index == 20 &&
        strcmp(value.route.interface_name, "utun4") == 0 && value.route.flags == (RTF_UP | RTF_STATIC) &&
        value.route.hop_count == 0 && value.route.scope_index == 0 &&
        value.route.gateway_kind == RELAY_TUN_ROUTE_INTERFACE, "captured stable route fields remain exact");
    check(value.kernel_mtu == 1500 && value.kernel_protocol_cloning && value.interface_address_family == AF_INET &&
        memcmp(value.interface_address, address, 16) == 0, "MTU, protocol cloning and exact interface address are retained");
    Frame request = encode(value.route); RelayTunRouteMessage encoded = decode(request);
    check(encoded.kernel_mtu == 0 && !encoded.kernel_protocol_cloning && encoded.interface_address_family == 0 &&
        memcmp(encoded.interface_address, empty, 16) == 0, "encoding stable route never inherits observation metadata");
    RelayTunRouteRecord invalid_request = value.route; invalid_request.flags |= RTF_PRCLONING;
    check(relay_tun_route_validate(&invalid_request) == RELAY_TUN_ROUTE_UNSUPPORTED,
        "requested route still cannot assert kernel protocol cloning");
    size_t written = 999; Frame untouched = request;
    check(relay_tun_route_encode(&invalid_request, RELAY_TUN_ROUTE_ADD, 0, 0, request.bytes, sizeof(request.bytes), &written) == RELAY_TUN_ROUTE_UNSUPPORTED &&
        written == 999 && memcmp(request.bytes, untouched.bytes, sizeof(request.bytes)) == 0,
        "encoder rejects observation flags without touching request bytes");
    Frame frame = good; struct rt_msghdr head = header(frame); head.rtm_type = RTM_ADD; set_header(&frame, head);
    refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "unconfirmed ADD cannot assert kernel observation metadata");
    head.rtm_flags |= RTF_DONE; set_header(&frame, head); value = decode(frame);
    check(value.confirmed && value.kernel_mtu == 1500 && value.kernel_protocol_cloning &&
        value.interface_address_family == AF_INET, "confirmed ADD also preserves kernel observation metadata");
    frame = good; head = header(frame); head.rtm_flags &= ~RTF_PRCLONING; head.rtm_rmx.rmx_mtu = 0; set_header(&frame, head);
    replace(&frame, RTAX_IFA, NULL, 0, false); value = decode(frame);
    check(value.kernel_mtu == 0 && !value.kernel_protocol_cloning && value.interface_address_family == 0 &&
        memcmp(value.interface_address, empty, 16) == 0, "absent kernel metadata stays explicitly absent");
    frame = good; head = header(frame); head.rtm_flags |= RTF_LLINFO; set_header(&frame, head);
    refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "kernel observation still rejects unknown flags");
    const size_t fields[] = {offsetof(struct rt_metrics, rmx_locks), offsetof(struct rt_metrics, rmx_expire),
        offsetof(struct rt_metrics, rmx_recvpipe), offsetof(struct rt_metrics, rmx_sendpipe),
        offsetof(struct rt_metrics, rmx_ssthresh), offsetof(struct rt_metrics, rmx_rtt),
        offsetof(struct rt_metrics, rmx_rttvar), offsetof(struct rt_metrics, rmx_filler)};
    for (size_t i = 0; i < sizeof(fields) / sizeof(fields[0]); ++i) {
        frame = good; frame.bytes[offsetof(struct rt_msghdr, rtm_rmx) + fields[i]] = 1;
        refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "kernel MTU support never permits unrelated metrics or locks");
    }
    frame = good; head = header(frame); head.rtm_inits |= RTV_MTU; set_header(&frame, head);
    refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "kernel observation does not authorize metric-init requests");
    const size_t ifa = position(good, RTAX_IFA);
    const size_t malformed_ifa[] = {1, 2, 3, 8, 15};
    for (size_t i = 0; i < sizeof(malformed_ifa) / sizeof(malformed_ifa[0]); ++i) {
        frame = good; frame.bytes[ifa + malformed_ifa[i]] = 1;
        refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "interface address rejects wrong family, port and padding");
    }
    frame = good; uint8_t short_address[8] = {8,AF_INET,0,0,198,18,0,1};
    replace(&frame, RTAX_IFA, short_address, sizeof(short_address), true);
    refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "interface address requires a complete canonical sockaddr");
    frame = good; uint8_t author[16] = {16,AF_INET}; replace(&frame, RTAX_AUTHOR, author, sizeof(author), true);
    refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "accepting IFA never accepts other address slots");
    for (unsigned variant = 0; variant < 6; ++variant) {
        RelayTunRouteRecord original = route(variant == 0 ? AF_INET6 : AF_INET, variant == 1);
        if (variant == 2) { original.prefix = 0; memset(original.destination, 0, 16); }
        if (variant == 3) { original.prefix = 32; original.flags |= RTF_HOST; }
        if (variant == 4) original.flags |= RTF_REJECT;
        if (variant == 5) original.flags |= RTF_BLACKHOLE;
        frame = encode(original); head = header(frame); head.rtm_type = RTM_GET; head.rtm_flags |= RTF_PRCLONING; set_header(&frame, head);
        refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "protocol cloning only describes an IPv4 interface subnet");
    }
    RelayTunRouteRecord original = route(AF_INET6, false); frame = encode(original);
    head = header(frame); head.rtm_type = RTM_GET; head.rtm_rmx.rmx_mtu = 1500; set_header(&frame, head);
    uint8_t address6[28] = {28,AF_INET6}; check(inet_pton(AF_INET6, "2001:db8::1", address6 + offsetof(struct sockaddr_in6, sin6_addr)) == 1, "IPv6 IFA fixture");
    replace(&frame, RTAX_IFA, address6, sizeof(address6), true); value = decode(frame);
    check(value.interface_address_family == AF_INET6 && memcmp(value.interface_address, address6 + 8, 16) == 0 &&
        value.kernel_mtu == 1500 && !value.kernel_protocol_cloning, "canonical IPv6 interface address and MTU are retained");
    address6[offsetof(struct sockaddr_in6, sin6_scope_id)] = 1; replace(&frame, RTAX_IFA, address6, sizeof(address6), true);
    refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "interface address cannot lose an explicit IPv6 zone");
}
static void ip_and_binding(void) {
    for (unsigned family = 0; family < 2; ++family) {
        RelayTunRouteRecord original = route(family == 0 ? AF_INET : AF_INET6, true); Frame good = encode(original), frame = good;
        size_t offset = position(frame, RTAX_GATEWAY); frame.bytes[offset + 2] = 1;
        refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "IP gateway port refuses");
        frame = good; offset = position(frame, RTAX_DST); frame.bytes[offset + 2] = 1;
        refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "destination port refuses");
        frame = good; offset = position(frame, RTAX_IFP); uint16_t wrong = 50;
        memcpy(frame.bytes + offset + offsetof(struct sockaddr_dl, sdl_index), &wrong, sizeof(wrong));
        refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "IFP index must agree with header");
        frame = good; replace(&frame, RTAX_IFP, NULL, 0, false); RelayTunRouteMessage value = decode(frame);
        check(value.route.interface_name[0] == 0 && value.route.interface_type == 0 && value.route.interface_index == original.interface_index, "missing IFP preserves index with unresolved metadata");
        if (family != 0) {
            frame = good; offset = position(frame, RTAX_GATEWAY); frame.bytes[offset + offsetof(struct sockaddr_in6, sin6_scope_id)] = 1;
            refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "IPv6 explicit zone refuses");
            frame = good; offset = position(frame, RTAX_GATEWAY); frame.bytes[offset + offsetof(struct sockaddr_in6, sin6_flowinfo)] = 1;
            refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "IPv6 flowinfo refuses");
            frame = good; offset = position(frame, RTAX_GATEWAY) + offsetof(struct sockaddr_in6, sin6_addr);
            memset(frame.bytes + offset, 0, 16); frame.bytes[offset] = 0xfe; frame.bytes[offset + 1] = 0x80; frame.bytes[offset + 3] = 49;
            refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "IPv6 embedded link-local zone refuses");
            frame.bytes[offset + 3] = 0; frame.bytes[offset + 15] = 1;
            refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "zero-zone IPv6 link-local gateway remains outside audited subset");
            frame.bytes[offset] = 0xff; frame.bytes[offset + 1] = 2;
            refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "interface-local multicast gateway remains outside audited subset");
        }
    }
    RelayTunRouteRecord original = route(AF_INET, false); Frame frame = encode(original);
    const size_t link_position = position(frame, RTAX_GATEWAY); const size_t link_length = frame.bytes[link_position];
    uint8_t link[256] = {0}; memcpy(link, frame.bytes + link_position, link_length);
    replace(&frame, RTAX_IFP, link, link_length, true); RelayTunRouteMessage value = decode(frame);
    check(same_route(&value.route, &original), "matching gateway/IFP metadata agrees");
    Frame mismatch = frame; size_t offset = position(mismatch, RTAX_IFP); mismatch.bytes[offset + offsetof(struct sockaddr_dl, sdl_type)] = 2;
    refuse(mismatch, RELAY_TUN_ROUTE_UNSUPPORTED, "gateway/IFP types cannot disagree");
    mismatch = frame; offset = position(mismatch, RTAX_IFP); mismatch.bytes[offset + offsetof(struct sockaddr_dl, sdl_data)] = 'x';
    refuse(mismatch, RELAY_TUN_ROUTE_UNSUPPORTED, "gateway/IFP names cannot disagree");
}
static void validation(void) {
    RelayTunRouteRecord original = route(AF_INET, false), value = original;
    uint8_t output[512], sentinel[512]; memset(output, 0xa5, sizeof(output)); memcpy(sentinel, output, sizeof(output)); size_t written = 999;
    check(relay_tun_route_encode(&original, RELAY_TUN_ROUTE_ADD, 0, 0, output, 1, &written) == RELAY_TUN_ROUTE_NO_SPACE && written == 999 && memcmp(output, sentinel, sizeof(output)) == 0, "small output is untouched");
    for (unsigned opcode = 0; opcode < 256; ++opcode) if (opcode != RELAY_TUN_ROUTE_ADD && opcode != RELAY_TUN_ROUTE_GET)
        check(relay_tun_route_encode(&original, (uint8_t)opcode, 0, 0, output, sizeof(output), &written) == RELAY_TUN_ROUTE_UNSUPPORTED, "all non-ADD/GET encoder opcodes refuse");
    value.interface_index = UINT16_MAX + 1u; check(relay_tun_route_validate(&value) == RELAY_TUN_ROUTE_INVALID, "index cannot narrow to16 bits");
    value = original; value.interface_index = 0; check(relay_tun_route_validate(&value) == RELAY_TUN_ROUTE_INVALID, "index zero refuses");
    value = original; memset(value.interface_name, 'a', IFNAMSIZ); check(relay_tun_route_validate(&value) == RELAY_TUN_ROUTE_INVALID, "unterminated name refuses");
    value = original; value.destination[15] = 1; check(relay_tun_route_validate(&value) == RELAY_TUN_ROUTE_INVALID, "IPv4 destination tail refuses");
    value = original; value.gateway[15] = 1; check(relay_tun_route_validate(&value) == RELAY_TUN_ROUTE_INVALID, "IPv4 gateway tail refuses");
    value = original; value.flags |= RTF_DONE; check(relay_tun_route_validate(&value) == RELAY_TUN_ROUTE_UNSUPPORTED, "record cannot own DONE flag");
    value = original; value.scope_index = 49; check(relay_tun_route_validate(&value) == RELAY_TUN_ROUTE_UNSUPPORTED, "nonzero index alone is not scope");
    value = original; value.flags |= RTF_IFSCOPE; check(relay_tun_route_validate(&value) == RELAY_TUN_ROUTE_UNSUPPORTED, "scope flag requires exact scope index");
    value = original; value.flags |= RTF_HOST; check(relay_tun_route_validate(&value) == RELAY_TUN_ROUTE_UNSUPPORTED, "HOST flag requires full prefix");
    value = original; value.flags |= RTF_GATEWAY; check(relay_tun_route_validate(&value) == RELAY_TUN_ROUTE_UNSUPPORTED, "AF_LINK interface gateway cannot be IP gateway flag");
    value = original; value.flags |= RTF_REJECT | RTF_BLACKHOLE; check(relay_tun_route_validate(&value) == RELAY_TUN_ROUTE_UNSUPPORTED, "contradictory rejection flags refuse");
    check(relay_tun_route_validate(NULL) == RELAY_TUN_ROUTE_INVALID, "null route refuses");
    check(relay_tun_route_decode(NULL, 0, NULL) == RELAY_TUN_ROUTE_INVALID, "null decode refuses");
    check(relay_tun_route_encode(&original, RELAY_TUN_ROUTE_ADD, -1, 0, output, sizeof(output), &written) == RELAY_TUN_ROUTE_INVALID, "negative request PID refuses");
}
static void mutation_corpus(void) {
    RelayTunRouteRecord original = route(AF_INET6, true); Frame good = encode(original);
    struct rt_msghdr head = header(good); head.rtm_type = RTM_GET; set_header(&good, head);
    for (size_t position = 0; position < good.length; ++position) for (unsigned bit = 0; bit < 8; ++bit) {
        Frame frame = good; frame.bytes[position] ^= (uint8_t)(1u << bit);
        RelayTunRouteMessage result; memset(&result, 0, sizeof(result));
        RelayTunRouteCode code = relay_tun_route_decode(frame.bytes, frame.length, &result);
        check(code >= RELAY_TUN_ROUTE_OK && code <= RELAY_TUN_ROUTE_KERNEL_ERROR, "bounded one-bit mutation returns a defined result");
        if (code == RELAY_TUN_ROUTE_OK) check(relay_tun_route_validate(&result.route) == RELAY_TUN_ROUTE_OK, "accepted mutation remains representable");
        RelayTunRouteKey key; code = relay_tun_route_key_decode(frame.bytes, frame.length, &key);
        check(code >= RELAY_TUN_ROUTE_OK && code <= RELAY_TUN_ROUTE_KERNEL_ERROR, "bounded key mutation returns a defined result");
    }
}
static void key_refuse(Frame frame, RelayTunRouteCode expected, const char *name) {
    RelayTunRouteKey sentinel, value; memset(&sentinel, 0xa5, sizeof(sentinel)); value = sentinel;
    check(relay_tun_route_key_decode(frame.bytes, frame.length, &value) == expected, name);
    check(memcmp(&sentinel, &value, sizeof(value)) == 0, "key refusal leaves output untouched");
}
static RelayTunRouteKey key_decode(Frame frame) {
    RelayTunRouteKey value; memset(&value, 0, sizeof(value));
    check(relay_tun_route_key_decode(frame.bytes, frame.length, &value) == RELAY_TUN_ROUTE_OK, "extract complete GET lookup key"); return value;
}
static bool same_key(const RelayTunRouteKey *a, const RelayTunRouteKey *b) {
    return a->family == b->family && a->prefix == b->prefix && a->scope_index == b->scope_index && a->zone_index == b->zone_index && memcmp(a->destination, b->destination, 16) == 0;
}
static void keys(void) {
    for (unsigned family = 0; family < 2; ++family) {
        RelayTunRouteRecord original = route(family == 0 ? AF_INET : AF_INET6, true); Frame good = encode(original);
        struct rt_msghdr head = header(good); head.rtm_type = RTM_GET; set_header(&good, head);
        const RelayTunRouteKey expected = key_decode(good);
        check(expected.family == original.family && expected.prefix == original.prefix && expected.scope_index == 0 && memcmp(expected.destination, original.destination, 16) == 0, "key keeps exact family prefix destination and unscoped lookup");
        Frame frame = good; head = header(frame); head.rtm_rmx.rmx_mtu = 9000; head.rtm_flags |= RTF_LLINFO | RTF_IFREF;
        set_header(&frame, head); refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "strict route refuses unrepresented value");
        RelayTunRouteKey value = key_decode(frame); check(same_key(&value, &expected), "unsupported metrics and flags retain exact occupying lookup key");
        frame = good; head = header(frame); head.rtm_index = 0; set_header(&frame, head); value = key_decode(frame);
        check(same_key(&value, &expected), "unscoped key does not require representable interface value");
        head.rtm_flags |= RTF_IFSCOPE; set_header(&frame, head); key_refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "scope with index zero refuses");
        frame = good; head = header(frame); head.rtm_flags |= RTF_IFSCOPE; set_header(&frame, head); value = key_decode(frame);
        check(value.scope_index == original.interface_index && !same_key(&value, &expected), "only IFSCOPE splits lookup keys");
        frame = good; head = header(frame); head.rtm_errno = ESRCH; set_header(&frame, head); key_refuse(frame, RELAY_TUN_ROUTE_KERNEL_ERROR, "key errno is not absence");
        frame = good; head = header(frame); head.rtm_addrs |= (int)0x80000000u; set_header(&frame, head); key_refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "unknown address bit cannot hide key");
        frame = good; frame.bytes[position(frame, RTAX_GATEWAY)] = 255; key_refuse(frame, RELAY_TUN_ROUTE_INVALID, "malformed value span blocks key extraction");
        frame = good; uint8_t opaque[2] = {2, AF_UNSPEC}; replace(&frame, RTAX_AUTHOR, opaque, sizeof(opaque), true); value = key_decode(frame);
        check(same_key(&value, &expected), "known bounded opaque value slot does not erase key");
        frame = good; size_t offset = position(frame, RTAX_DST) + (family == 0 ? offsetof(struct sockaddr_in, sin_addr) : offsetof(struct sockaddr_in6, sin6_addr));
        frame.bytes[offset + (family == 0 ? 3 : 15)] = 1; key_refuse(frame, RELAY_TUN_ROUTE_INVALID, "unaligned lookup network is not trusted");
        frame = good; offset = position(frame, RTAX_NETMASK) + (family == 0 ? offsetof(struct sockaddr_in, sin_addr) : offsetof(struct sockaddr_in6, sin6_addr));
        frame.bytes[offset] = 0xfd; key_refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "noncontiguous key mask refuses");
        original.prefix = family == 0 ? 32 : 128; frame = encode(original); head = header(frame); head.rtm_type = RTM_GET; set_header(&frame, head);
        const RelayTunRouteKey full = key_decode(frame); head.rtm_flags |= RTF_HOST; set_header(&frame, head); value = key_decode(frame);
        check(same_key(&full, &value), "full prefix and HOST describe the same lookup key");
        replace(&frame, RTAX_NETMASK, NULL, 0, false); value = key_decode(frame); check(same_key(&full, &value), "explicit HOST with omitted mask retains full lookup key");
        frame = good; head = header(frame); head.rtm_flags |= RTF_HOST; set_header(&frame, head); key_refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "HOST and shorter mask are inconsistent");
        frame = good;
        for (size_t length = 0; length < good.length; ++length) { frame.length = length; key_refuse(frame, RELAY_TUN_ROUTE_INVALID, "truncated dump entry never yields a key"); }
    }
    RelayTunRouteRecord original = route(AF_INET, false); Frame frame = encode(original);
    key_refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "key extractor accepts dump GET, never ADD notification");
}
static void zones(void) {
    RelayTunRouteRecord original = route(AF_INET6, false);
    check(inet_pton(AF_INET6, "fe80::", original.destination) == 1, "zone fixture destination"); original.prefix = 64;
    Frame good = encode(original); struct rt_msghdr head = header(good); head.rtm_type = RTM_GET; set_header(&good, head);
    const size_t address = position(good, RTAX_DST) + offsetof(struct sockaddr_in6, sin6_addr);
    const size_t explicit_offset = position(good, RTAX_DST) + offsetof(struct sockaddr_in6, sin6_scope_id);
    const RelayTunRouteKey canonical = key_decode(good);
    check(canonical.zone_index == 0, "ordinary unzoned key remains zero-zone");
    Frame frame = good; frame.bytes[address + 3] = 91; head = header(frame); head.rtm_index = 1; set_header(&frame, head);
    RelayTunRouteKey value = key_decode(frame);
    check(value.zone_index == 91 && value.scope_index == 0 && memcmp(value.destination, canonical.destination, 16) == 0, "embedded network-order zone survives independently from outgoing loopback index");
    refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "typed route refuses nonzero embedded zone rather than erasing metadata");
    frame = good; uint32_t explicit_zone = 65536;
    memcpy(frame.bytes + explicit_offset, &explicit_zone, sizeof(explicit_zone)); value = key_decode(frame);
    check(value.zone_index == 65536 && memcmp(value.destination, canonical.destination, 16) == 0, "native-order explicit zone retains complete UInt32 without narrowing");
    refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "typed route refuses explicit-only zone");
    frame = good; frame.bytes[address + 2] = 1; frame.bytes[address + 3] = 2; explicit_zone = 258;
    memcpy(frame.bytes + explicit_offset, &explicit_zone, sizeof(explicit_zone)); value = key_decode(frame);
    check(value.zone_index == 258, "matching embedded network-u16 and explicit native-u32 zone agree");
    explicit_zone = 259; memcpy(frame.bytes + explicit_offset, &explicit_zone, sizeof(explicit_zone));
    key_refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "contradictory explicit and embedded zone refuses");
    frame = good; check(inet_pton(AF_INET6, "2001:db8::", frame.bytes + address) == 1, "global scope fixture");
    memcpy(frame.bytes + explicit_offset, &explicit_zone, sizeof(explicit_zone));
    key_refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "global destination cannot carry an unmodeled explicit zone");
    const uint8_t classes[] = {0x01, 0x02, 0x12, 0x31, 0x32, 0x00, 0x05};
    for (size_t i = 0; i < sizeof(classes); ++i) {
        frame = good; memset(frame.bytes + address, 0, 16); frame.bytes[address] = 0xff;
        frame.bytes[address + 1] = classes[i]; frame.bytes[address + 3] = 5;
        value = key_decode(frame);
        const bool recognized = classes[i] == 0x01 || classes[i] == 0x02 || classes[i] == 0x12 || classes[i] == 0x31;
        check(value.zone_index == (recognized ? 5u : 0u) && value.destination[3] == (recognized ? 0 : 5), "only XNU scope-embed multicast classes normalize their zone bytes");
        if (recognized) refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "typed multicast route never loses a recognized nonzero zone");
        else {
            explicit_zone = 5; memcpy(frame.bytes + explicit_offset, &explicit_zone, sizeof(explicit_zone));
            key_refuse(frame, RELAY_TUN_ROUTE_UNSUPPORTED, "reserved, global or unicast-prefix multicast class cannot adopt explicit zone");
        }
    }
}
int main(int argc, char **argv) {
    (void)argv;
    if (argc != 1 || getuid() == 0 || geteuid() == 0) { fputs("Pure codec fixtures refuse root and arguments.\n", stderr); return 77; }
    round_trips(); masks(); radix_masks(); malformed(); metrics(); kernel_metadata(); ip_and_binding(); validation(); keys(); zones(); mutation_corpus();
    printf("{\"passed\":%u,\"failed\":0,\"scope\":\"pure-route-codec-fixtures\",\"networkOperations\":0,\"actualTunAccepted\":false}\n", checks);
    return 0;
}
