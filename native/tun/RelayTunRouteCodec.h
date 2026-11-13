#ifndef RELAY_TUN_ROUTE_CODEC_H
#define RELAY_TUN_ROUTE_CODEC_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <net/if.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Pure Darwin rt_msghdr v5 bytes only: no socket, lookup, allocation, root,
 * authorization or network operation. This is a deliberately bounded route
 * subset, not a complete route backup format. Unsupported information refuses
 * projection instead of silently dropping it. Never encode a delete/change. */
typedef enum {
    RELAY_TUN_ROUTE_OK = 0,
    RELAY_TUN_ROUTE_INVALID,
    RELAY_TUN_ROUTE_UNSUPPORTED,
    RELAY_TUN_ROUTE_NO_SPACE,
    RELAY_TUN_ROUTE_KERNEL_ERROR
} RelayTunRouteCode;
enum { RELAY_TUN_ROUTE_INTERFACE = 0, RELAY_TUN_ROUTE_IP = 1 };
enum { RELAY_TUN_ROUTE_ADD = 1, RELAY_TUN_ROUTE_GET = 4 };
#define RELAY_TUN_ROUTE_MAX_MESSAGE 512

typedef struct {
    int32_t family;                 /* AF_INET or AF_INET6 */
    uint8_t prefix;                 /* contiguous mask; destination aligned */
    uint8_t destination[16];        /* network byte order; IPv4 tail is zero */
    uint8_t gateway_kind;           /* INTERFACE(AF_LINK) or same-family IP */
    uint8_t gateway[16];            /* zero for an interface route */
    uint32_t interface_index;       /* 1...65535; never silently narrowed */
    char interface_name[IFNAMSIZ];  /* bounded ASCII; empty if index-only */
    uint8_t interface_type;         /* AF_LINK sdl_type metadata, preserved */
    uint32_t scope_index;           /* 0, or index with RTF_IFSCOPE */
    uint32_t flags;                 /* supported stable flags; excludes DONE */
    uint32_t hop_count;             /* Darwin rmx_hopcount */
} RelayTunRouteRecord;

typedef struct {
    RelayTunRouteRecord route;
    int32_t pid;
    int32_t sequence;
    uint8_t operation;              /* only ADD or GET */
    bool confirmed;                /* successful message had RTF_DONE */
    /* Read-only kernel metadata, never encoded as requested route authority.
     * Consumers must bind MTU/IFA to the positively owned interface before
     * treating route equality as evidence of their installed effect. */
    uint32_t kernel_mtu;            /* zero when no MTU is reported */
    bool kernel_protocol_cloning;  /* IPv4 interface subnet RTF_PRCLONING */
    int32_t interface_address_family; /* zero when RTA_IFA is absent */
    uint8_t interface_address[16];  /* exact canonical RTA_IFA address */
} RelayTunRouteMessage;

typedef struct {
    int32_t family;
    uint8_t prefix;
    uint8_t destination[16];
    uint32_t scope_index;
    uint32_t zone_index;            /* IPv6 destination zone, separate from scope */
} RelayTunRouteKey;

/* A name is optional when an observation provides only an index. A caller
 * requiring a name must independently resolve and bind that index; no lookup
 * occurs here. IP-route interface metadata comes from RTA_IFP when present. */
RelayTunRouteCode relay_tun_route_validate(const RelayTunRouteRecord *route);
/* Encodes one request; pid/sequence must be nonnegative. Output and *written
 * remain untouched on failure. No opcode other than ADD/GET is accepted. */
RelayTunRouteCode relay_tun_route_encode(const RelayTunRouteRecord *route,
                                       uint8_t operation, int32_t pid, int32_t sequence,
                                       void *output, size_t capacity, size_t *written);
/* Requires exactly one complete frame, accepts unaligned input, and leaves
 * output untouched on refusal. Nonzero rtm_errno is KERNEL_ERROR, never absence.
 * DONE and runtime counters rtm_use/rmx_pksent are normalized. GET or confirmed
 * ADD observations retain kernel MTU, canonical RTA_IFA and bounded IPv4
 * interface-subnet PRCLONING separately; requests still accept none of them.
 * Other metrics/addresses/flags, IPv6 zones, link MACs and selectors refuse.
 * IP gateways requiring IPv6 link-local/interface-local multicast zones also
 * refuse even with a zero zone; that routing-context subset is not audited. */
RelayTunRouteCode relay_tun_route_decode(const void *bytes, size_t length,
                                       RelayTunRouteMessage *output);
/* Key-only extraction from a complete RTM_GET dump entry. Known value address
 * slots are bounded but not projected; unsupported value flags/metrics do not
 * hide a route occupying the lookup key. Malformed keys/frames still refuse,
 * and refusal is never evidence of absence. Recognized IPv6 embedded zones are
 * cleared from destination and retained here with an agreeing explicit zone;
 * they are NOT assumed to equal rtm_index. Full route decode still refuses any
 * nonzero zone. Output is untouched on refusal. */
RelayTunRouteCode relay_tun_route_key_decode(const void *bytes, size_t length,
                                           RelayTunRouteKey *output);

#ifdef __cplusplus
}
#endif
#endif
