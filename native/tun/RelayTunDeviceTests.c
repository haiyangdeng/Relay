#include "RelayTunDevice.h"
#include <arpa/inet.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <sys/kern_control.h>
#include <sys/sys_domain.h>
#include <unistd.h>

/* Available only in the separately compiled inert test binary. These entry
 * points validate already supplied metadata/outcomes and never call an OS API. */
extern RelayTunDeviceCode relay_tun_device_test_observation(const struct sockaddr_ctl *, socklen_t,
    const char [IFNAMSIZ], socklen_t, unsigned int, RelayTunDeviceError *);
extern RelayTunDeviceCode relay_tun_device_test_creation_failure(RelayTunDeviceError, int, int, RelayTunDeviceError *);

static unsigned int checks, failures;
static void check(bool passed, const char *name) {
    checks++;
    if (!passed) { failures++; fprintf(stderr, "FAIL: %s\n", name); }
}
static void mask_test(int family, unsigned int bits, const char *expected) {
    uint8_t actual[16], wanted[16] = {0};
    RelayTunDeviceError error;
    check(inet_pton(family, expected, wanted) == 1 &&
          relay_tun_device_prefix_mask(family, bits, actual, &error) == RELAY_TUN_DEVICE_OK &&
          !memcmp(actual, wanted, 16), "network-order prefix-mask boundary");
}
static bool denied(RelayTunDeviceCode code, RelayTunDeviceError error) {
    return code == RELAY_TUN_DEVICE_PERMISSION && error.code == RELAY_TUN_DEVICE_PERMISSION &&
        error.stage == RELAY_TUN_STAGE_PERMISSION && error.system_error == EPERM &&
        !error.network_may_have_changed;
}
static bool observation_refused(struct sockaddr_ctl peer, socklen_t length, const char name[IFNAMSIZ],
                                socklen_t name_length, unsigned int index, int reason) {
    RelayTunDeviceError error;
    return relay_tun_device_test_observation(&peer, length, name, name_length, index, &error) == RELAY_TUN_DEVICE_IDENTITY &&
        error.code == RELAY_TUN_DEVICE_IDENTITY && error.stage == RELAY_TUN_STAGE_OBSERVE &&
        error.system_error == reason && !error.network_may_have_changed;
}
static void observation_tests(void) {
    struct sockaddr_ctl valid = {.sc_len = sizeof(struct sockaddr_ctl), .sc_family = AF_SYSTEM,
        .ss_sysaddr = AF_SYS_CONTROL, .sc_id = 17, .sc_unit = 43};
    char name[IFNAMSIZ] = "utun42"; RelayTunDeviceError error;
    check(relay_tun_device_test_observation(&valid, sizeof(valid), name, 7, 91, &error) == RELAY_TUN_DEVICE_OK &&
          error.code == RELAY_TUN_DEVICE_OK, "peer controller plus exact NUL-terminated IFNAME and observed index is accepted");
    check(observation_refused(valid, sizeof(valid) - 1, name, 7, 91, EPROTOTYPE), "truncated peer sockaddr cannot identify the controller");
    check(observation_refused(valid, sizeof(valid) + 1, name, 7, 91, EPROTOTYPE), "unexpected peer sockaddr size cannot identify the controller");
    struct sockaddr_ctl malformed_size = valid; malformed_size.sc_len = sizeof(valid) - 1;
    check(observation_refused(malformed_size, sizeof(valid), name, 7, 91, EPROTOTYPE), "peer's embedded length must match its returned sockaddr size");
    struct sockaddr_ctl wrong = valid; wrong.sc_family = AF_UNIX;
    check(observation_refused(wrong, sizeof(wrong), name, 7, 91, EPROTOTYPE), "unrelated socket family refuses");
    wrong = valid; wrong.ss_sysaddr = 0;
    check(observation_refused(wrong, sizeof(wrong), name, 7, 91, EPROTOTYPE), "peer must be the kernel-control system address");
    wrong = valid; wrong.sc_id = 0;
    check(observation_refused(wrong, sizeof(wrong), name, 7, 91, EPROTOTYPE), "missing controller ID refuses");
    wrong = valid; wrong.sc_unit = 0;
    check(observation_refused(wrong, sizeof(wrong), name, 7, 91, EPROTOTYPE), "automatic request unit cannot substitute an allocated peer unit");
    wrong = valid; wrong.sc_unit = 44;
    check(observation_refused(wrong, sizeof(wrong), name, 7, 91, ENXIO), "allocated peer unit must agree with the IFNAME numeric suffix plus one");
    check(observation_refused(valid, sizeof(valid), name, 7, 0, ENXIO), "an interface name without an observed positive index refuses");
    const socklen_t lengths[] = {0, 1, 6, IFNAMSIZ + 1};
    for (size_t i = 0; i < sizeof(lengths) / sizeof(lengths[0]); ++i)
        check(observation_refused(valid, sizeof(valid), name, lengths[i], 91, EINVAL), "IFNAME return length includes exactly its terminating NUL");
    char malformed[IFNAMSIZ] = "utun";
    check(observation_refused(valid, sizeof(valid), malformed, 5, 91, ENXIO), "bare automatic request name is never an observed interface identity");
    strcpy(malformed, "utun042");
    check(observation_refused(valid, sizeof(valid), malformed, 8, 91, ENXIO), "observed interface suffix cannot have leading zeroes");
    memset(malformed, 'a', sizeof(malformed));
    check(observation_refused(valid, sizeof(valid), malformed, IFNAMSIZ, 91, EINVAL), "unterminated kernel name refuses within the fixed buffer");
    memset(malformed, 0, sizeof(malformed)); memcpy(malformed, "utun\0x", 6);
    check(observation_refused(valid, sizeof(valid), malformed, 7, 91, EINVAL), "embedded NUL cannot shorten the declared observed name");
    strcpy(name, "utun4294967294"); valid.sc_unit = UINT32_MAX;
    check(relay_tun_device_test_observation(&valid, sizeof(valid), name, (socklen_t)strlen(name) + 1, 1, &error) == RELAY_TUN_DEVICE_OK,
          "largest observed unit remains representable without wrapping");
    const int reasons[] = {EOPNOTSUPP, ENOTCONN, ENOTSOCK, EPROTOTYPE, EINVAL, ENXIO, ESTALE};
    for (size_t i = 0; i < sizeof(reasons) / sizeof(reasons[0]); ++i) {
        const RelayTunDeviceError cause = {RELAY_TUN_DEVICE_IDENTITY, RELAY_TUN_STAGE_OBSERVE, reasons[i], false};
        check(relay_tun_device_test_creation_failure(cause, 0, EBADF, &error) == cause.code &&
              error.code == cause.code && error.stage == cause.stage && error.system_error == reasons[i] && error.network_may_have_changed,
              "successful partial-creation close preserves the original observation reason instead of replacing it with ESTALE");
    }
    const RelayTunDeviceError allocation = {RELAY_TUN_DEVICE_SYSTEM, RELAY_TUN_STAGE_OBSERVE, ENOMEM, false};
    check(relay_tun_device_test_creation_failure(allocation, 0, EIO, &error) == RELAY_TUN_DEVICE_SYSTEM &&
          error.stage == RELAY_TUN_STAGE_OBSERVE && error.system_error == ENOMEM && error.network_may_have_changed,
          "allocation failure keeps its original cause after successful partial-device cleanup");
    const RelayTunDeviceError collision = {RELAY_TUN_DEVICE_EXISTS, RELAY_TUN_STAGE_CONNECT, EBUSY, true};
    check(relay_tun_device_test_creation_failure(collision, 0, EIO, &error) == RELAY_TUN_DEVICE_EXISTS &&
          error.stage == RELAY_TUN_STAGE_CONNECT && error.system_error == EBUSY && error.network_may_have_changed,
          "failed connection retains its exact collision reason after a single successful cleanup close");
    const int close_reasons[] = {EINTR, EBADF, EIO};
    for (size_t i = 0; i < sizeof(close_reasons) / sizeof(close_reasons[0]); ++i)
        check(relay_tun_device_test_creation_failure(allocation, -1, close_reasons[i], &error) == RELAY_TUN_DEVICE_SYSTEM &&
              error.code == RELAY_TUN_DEVICE_SYSTEM && error.stage == RELAY_TUN_STAGE_CLOSE &&
              error.system_error == close_reasons[i] && error.network_may_have_changed,
              "uncertain cleanup close has explicit highest-priority CLOSE error and never asks to retry an FD");
    check(relay_tun_device_test_creation_failure(allocation, 0, EIO, NULL) == RELAY_TUN_DEVICE_SYSTEM,
          "partial-creation failure remains correct when caller omits its error output");
}
int main(int argc, char **argv) {
    (void)argv;
    /* This binary has no root-test mode. It must never exercise device creation
     * or interface configuration, even if launched by an administrator. */
    if (argc != 1 || getuid() == 0 || geteuid() == 0) {
        fprintf(stderr, "The inert device test refuses root and all arguments.\n"); return 77;
    }
    observation_tests();
    RelayTunDeviceError error;
    uint32_t unit = UINT32_MAX;
    check(relay_tun_device_parse_name("utun", &unit, &error) == RELAY_TUN_DEVICE_OK && unit == 0,
          "automatic allocation has kernel unit zero");
    check(relay_tun_device_parse_name("utun0", &unit, &error) == RELAY_TUN_DEVICE_OK && unit == 1,
          "explicit utun0 maps to kernel unit one");
    check(relay_tun_device_parse_name("utun42", &unit, &error) == RELAY_TUN_DEVICE_OK && unit == 43,
          "explicit name preserves its numeric interface identity");
    check(relay_tun_device_parse_name("utun4294967294", &unit, &error) == RELAY_TUN_DEVICE_OK && unit == UINT32_MAX,
          "largest representable explicit unit does not wrap");
    const char *bad_names[] = {"", "en0", "UTUN0", "utun01", "utun-1", "utun+1", "utun1 ",
        "utun4294967295", "utun999999999999999999", "utun0/1", "utun0;touch", "utun1\n"};
    for (unsigned int i = 0; i < sizeof(bad_names) / sizeof(*bad_names); ++i) {
        unit = 123;
        check(relay_tun_device_parse_name(bad_names[i], &unit, &error) != RELAY_TUN_DEVICE_OK && unit == 123,
              "invalid name does not replace the caller's parsed value");
    }
    check(relay_tun_device_parse_name(NULL, &unit, &error) == RELAY_TUN_DEVICE_INVALID,
          "missing device name is rejected");
    char unterminated_name[IFNAMSIZ]; memset(unterminated_name, 'u', sizeof(unterminated_name));
    check(relay_tun_device_parse_name(unterminated_name, &unit, &error) == RELAY_TUN_DEVICE_INVALID,
          "bounded name parser rejects nonterminated input");
    check(relay_tun_device_validate_mtu(0, &error) == RELAY_TUN_DEVICE_UNSUPPORTED,
          "zero MTU is not silently replaced");
    check(relay_tun_device_validate_mtu(UINT32_MAX, &error) == RELAY_TUN_DEVICE_UNSUPPORTED,
          "MTU cannot overflow signed SIOCSIFMTU storage");
    const uint32_t valid_mtu[] = {1, 1280, 1500, 65535, 65536, INT32_MAX};
    for (unsigned int i = 0; i < sizeof(valid_mtu) / sizeof(*valid_mtu); ++i)
        check(relay_tun_device_validate_mtu(valid_mtu[i], &error) == RELAY_TUN_DEVICE_OK,
              "MTU preserves representable values for actual kernel validation");
    mask_test(AF_INET, 0, "0.0.0.0"); mask_test(AF_INET, 1, "128.0.0.0");
    mask_test(AF_INET, 7, "254.0.0.0"); mask_test(AF_INET, 8, "255.0.0.0");
    mask_test(AF_INET, 9, "255.128.0.0"); mask_test(AF_INET, 31, "255.255.255.254");
    mask_test(AF_INET, 32, "255.255.255.255");
    mask_test(AF_INET6, 0, "::"); mask_test(AF_INET6, 1, "8000::");
    mask_test(AF_INET6, 63, "ffff:ffff:ffff:fffe::");
    mask_test(AF_INET6, 64, "ffff:ffff:ffff:ffff::");
    mask_test(AF_INET6, 65, "ffff:ffff:ffff:ffff:8000::");
    mask_test(AF_INET6, 127, "ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe");
    mask_test(AF_INET6, 128, "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff");
    uint8_t mask[16]; memset(mask, 0xa5, sizeof(mask));
    check(relay_tun_device_prefix_mask(AF_INET, 33, mask, &error) == RELAY_TUN_DEVICE_INVALID && mask[0] == 0xa5,
          "IPv4 prefix overflow does not mutate output");
    check(relay_tun_device_prefix_mask(AF_INET6, 129, mask, &error) == RELAY_TUN_DEVICE_INVALID,
          "IPv6 prefix overflow is rejected");
    check(relay_tun_device_prefix_mask(AF_UNIX, 1, mask, &error) == RELAY_TUN_DEVICE_INVALID,
          "unrelated address families are rejected");
    RelayTunDevicePrefix ipv4, ipv6;
    check(relay_tun_device_parse_prefix("172.19.0.1/30", AF_INET, &ipv4, &error) == RELAY_TUN_DEVICE_OK &&
          ipv4.address[0] == 172 && ipv4.address[3] == 1 && ipv4.mask[3] == 252 && ipv4.prefix == 30,
          "IPv4 retains host address and correct network mask");
    check(relay_tun_device_parse_prefix("fd00:1234::1/64", AF_INET6, &ipv6, &error) == RELAY_TUN_DEVICE_OK &&
          ipv6.address[0] == 0xfd && ipv6.address[15] == 1 && ipv6.mask[7] == 255 && ipv6.mask[8] == 0,
          "IPv6 retains host address and correct prefix mask");
    RelayTunDevicePrefix alternative;
    check(relay_tun_device_parse_prefix("FD00:1234:0:0:0:0:0:1/64", AF_INET6, &alternative, &error) == RELAY_TUN_DEVICE_OK &&
          !memcmp(ipv6.address, alternative.address, 16), "valid expanded and uppercase IPv6 is preserved");
    check(relay_tun_device_parse_prefix("::ffff:192.0.2.1/128", AF_INET6, &alternative, &error) == RELAY_TUN_DEVICE_OK,
          "canonical IPv4-embedded IPv6 is supported");
    check(relay_tun_device_parse_prefix("::ffff:192.000.2.1/128", AF_INET6, &alternative, &error) == RELAY_TUN_DEVICE_INVALID,
          "ambiguous IPv4-embedded IPv6 is rejected");
    const char *bad_prefixes[] = {"172.19.0.1", "172.19.0.1/", "172.19.0.1/-1", "172.19.0.1/+1",
        "172.19.0.1/01", "172.19.0.1/33", "172.19.0.1/999999999", " 172.19.0.1/24",
        "172.19.0.1/24 ", "172.19.0.1/24/1", "256.1.1.1/24", "172.019.0.1/24", "::1/32"};
    for (unsigned int i = 0; i < sizeof(bad_prefixes) / sizeof(*bad_prefixes); ++i)
        check(relay_tun_device_parse_prefix(bad_prefixes[i], AF_INET, &ipv4, &error) == RELAY_TUN_DEVICE_INVALID,
              bad_prefixes[i]);
    const char *bad_ipv6[] = {"fd00::1/129", "fe80::1%en0/64", "fd00::1/064", "::gg/64", "172.19.0.1/24"};
    for (unsigned int i = 0; i < sizeof(bad_ipv6) / sizeof(*bad_ipv6); ++i)
        check(relay_tun_device_parse_prefix(bad_ipv6[i], AF_INET6, &ipv6, &error) == RELAY_TUN_DEVICE_INVALID,
              bad_ipv6[i]);
    uint8_t peer[16], expected[16];
    check(relay_tun_device_ipv6_destination(&ipv6, peer, &error) == RELAY_TUN_DEVICE_OK &&
          !memcmp(peer, (uint8_t[16]){0}, 16), "non-host IPv6 prefix leaves peer unspecified");
    check(relay_tun_device_parse_prefix("fd00::ff/128", AF_INET6, &ipv6, &error) == RELAY_TUN_DEVICE_OK &&
          relay_tun_device_ipv6_destination(&ipv6, peer, &error) == RELAY_TUN_DEVICE_OK &&
          inet_pton(AF_INET6, "fd00::100", expected) == 1 && !memcmp(peer, expected, 16),
          "IPv6 host-prefix peer increment carries across bytes");
    check(relay_tun_device_parse_prefix("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128", AF_INET6, &ipv6, &error) == RELAY_TUN_DEVICE_OK &&
          relay_tun_device_ipv6_destination(&ipv6, peer, &error) == RELAY_TUN_DEVICE_UNSUPPORTED,
          "last IPv6 host cannot silently wrap its destination to zero");
    ipv6.mask[0] = 0;
    check(relay_tun_device_ipv6_destination(&ipv6, peer, &error) == RELAY_TUN_DEVICE_INVALID,
          "a forged prefix with inconsistent mask is rejected");
    uint32_t random = UINT32_C(0x63726166); bool bounded = true;
    for (unsigned int iteration = 0; iteration < 20000; ++iteration) {
        char input[65];
        random = random * UINT32_C(1664525) + UINT32_C(1013904223);
        unsigned int length = random % 65;
        for (unsigned int j = 0; j < length; ++j) {
            random = random * UINT32_C(1664525) + UINT32_C(1013904223);
            input[j] = (char)(random >> 24);
        }
        input[length] = 0;
        RelayTunDeviceCode name_code = relay_tun_device_parse_name(input, &unit, &error);
        RelayTunDeviceCode prefix_code = relay_tun_device_parse_prefix(input,
            iteration % 2 ? AF_INET : AF_INET6, &alternative, &error);
        bounded = bounded && (name_code == RELAY_TUN_DEVICE_OK || name_code == RELAY_TUN_DEVICE_INVALID) &&
            (prefix_code == RELAY_TUN_DEVICE_OK || prefix_code == RELAY_TUN_DEVICE_INVALID);
    }
    check(bounded, "20000 deterministic bounded byte inputs remain pure parser operations");
    RelayTunDevice *device = NULL; RelayTunDeviceSnapshot snapshot; int duplicate = -99;
    RelayTunDeviceCode code = relay_tun_device_create("utun", &device, &error);
    check(denied(code, error) && device == NULL, "normal UID create rejects before any device operation");
    code = relay_tun_device_create("utun42", &device, &error);
    check(denied(code, error), "normal UID explicit-unit create never probes or replaces that interface");
    code = relay_tun_device_snapshot(NULL, &snapshot, &error);
    check(denied(code, error), "normal UID snapshot does not touch a socket or ioctl");
    code = relay_tun_device_set_mtu(NULL, 1500, &error);
    check(denied(code, error), "normal UID MTU rejects before inspecting the handle");
    code = relay_tun_device_add_ipv4(NULL, &ipv4, &error);
    check(denied(code, error), "normal UID IPv4 rejects before any ioctl");
    code = relay_tun_device_add_ipv6(NULL, &ipv6, &error);
    check(denied(code, error), "normal UID IPv6 rejects before any ioctl");
    code = relay_tun_device_duplicate_fd(NULL, &duplicate, &error);
    check(denied(code, error) && duplicate == -99, "normal UID never duplicates a live FD");
    code = relay_tun_device_close(&device, &error);
    check(denied(code, error), "normal UID close cannot adopt an interface or descriptor");
    RelayTunDeviceTestCounters counters = relay_tun_device_test_counters();
    check(counters.socket_calls == 0 && counters.ioctl_calls == 0 && counters.connect_calls == 0 &&
          counters.observe_calls == 0 && counters.fd_calls == 0 && counters.close_calls == 0,
          "all guarded calls performed zero socket/ioctl/connect/interface/FD operations");
    printf("{\"checks\":%u,\"passed\":%u,\"uid\":%u,\"euid\":%u,"
           "\"socketCalls\":%llu,\"ioctlCalls\":%llu,\"connectCalls\":%llu,"
           "\"observeCalls\":%llu,\"fdCalls\":%llu,\"closeCalls\":%llu,"
           "\"actualTunAccepted\":false,\"helperInstalled\":false,"
           "\"actualNetworkConfigurationChanged\":false}\n",
           checks, checks - failures, getuid(), geteuid(),
           (unsigned long long)counters.socket_calls, (unsigned long long)counters.ioctl_calls,
           (unsigned long long)counters.connect_calls, (unsigned long long)counters.observe_calls,
           (unsigned long long)counters.fd_calls, (unsigned long long)counters.close_calls);
    return failures ? 1 : 0;
}
