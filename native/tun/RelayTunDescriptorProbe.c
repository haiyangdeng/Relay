#include "RelayTunDevice.h"
#include "RelayTunDescriptorProbeBuild.h"
#include <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <inttypes.h>
#include <libproc.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* Fixed physical cross-UID FD test, not an authenticated Mach session. The
 * default client has no configuration writes, routing, DNS, packet I/O or core.
 * The separately compiled CORE_TEST client adopts a fixed core with its own
 * disclosed TUN packet loops and attempted DNS-cache flush on shutdown. The
 * pinned client executes only after setgroups/setgid/setuid. Its user-owned
 * path is not an adversarial-user trust store: before/after digest checks do
 * not make execve(path) an atomic immutable launch or grant a privileged exec. */
#define OUTPUT_LIMIT 4096
#define FD_LIMIT 4096
#define CLIENT_LIMIT (64 * 1024 * 1024)
#ifndef RELAY_PROBE_ACTION
#define RELAY_PROBE_ACTION "--create-deliver-and-release"
#endif
#ifndef RELAY_PROBE_CLIENT_ARGUMENT
#define RELAY_PROBE_CLIENT_ARGUMENT "--admit-received-device"
#endif
#ifndef RELAY_PROBE_EXPECTED_REPLY
#define RELAY_PROBE_EXPECTED_REPLY "{\"version\":1,\"receiptBindingValidated\":true,\"ordinaryUID\":true,\"FDClosed\":true,\"actualTunAccepted\":false}\n"
#endif
#ifndef RELAY_PROBE_TIMEOUT_NS
#define RELAY_PROBE_TIMEOUT_NS UINT64_C(10000000000)
#endif
#ifndef RELAY_PROBE_CORE_TEST
#define RELAY_PROBE_CORE_TEST 0
#endif
/* Compile-time fixed fixtures only; no caller-controlled action/child/reply. */
static const char success_reply[] = RELAY_PROBE_EXPECTED_REPLY;
typedef struct { const char *stage; int system_error, close_error; } ClientCheck;
typedef struct {
    const char *status;
    bool privileged, client_verified, client_reverified, create_attempted, created, observed, duplicated;
    bool forked, child_exited, child_timed_out, child_report_validated, parent_delivery_closed;
    bool primary_close_attempted, primary_closed, primary_released, absence_checked, absent;
    unsigned int absence_checks;
    int system_error, child_wait_status, absence_error;
    RelayTunDeviceSnapshot identity;
    RelayTunDeviceError device_error;
    bool read_only;
    ClientCheck client_before, client_after;
    char child_output[OUTPUT_LIMIT];
    size_t child_output_length;
} Report;
static uint64_t now_ns(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return 0;
    return (uint64_t)value.tv_sec * UINT64_C(1000000000) + (uint64_t)value.tv_nsec;
}
static bool same_file(const struct stat *a, const struct stat *b) {
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_mode == b->st_mode &&
        a->st_uid == b->st_uid && a->st_gid == b->st_gid && a->st_nlink == b->st_nlink && a->st_size == b->st_size &&
        a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec && a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec &&
        a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec && a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
}
static bool client_failure(ClientCheck *check, const char *stage, int error) {
    check->stage = stage; check->system_error = error; return false;
}
static bool verify_client(ClientCheck *check) {
    *check = (ClientCheck){.stage = "lstat"};
    struct stat linked, opened, after, final;
    if (lstat(RELAY_PROBE_CLIENT_PATH, &linked) != 0) return client_failure(check, "lstat", errno);
    if (!S_ISREG(linked.st_mode) || linked.st_nlink != 1 || linked.st_uid != RELAY_PROBE_CLIENT_UID ||
        (linked.st_mode & 07777) != 0755) return client_failure(check, "metadata", EPERM);
    if (linked.st_size <= 0 || linked.st_size > CLIENT_LIMIT) return client_failure(check, "size", EFBIG);
    const int fd = open(RELAY_PROBE_CLIENT_PATH, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
    if (fd < 0) return client_failure(check, "open", errno);
    bool valid = true;
    if (fstat(fd, &opened) != 0) valid = client_failure(check, "fstat_opened", errno);
    else if (!same_file(&linked, &opened)) valid = client_failure(check, "opened_identity", ESTALE);
    const size_t size = (size_t)linked.st_size;
    unsigned char *bytes = valid ? malloc(size) : NULL;
    if (valid && bytes == NULL) valid = client_failure(check, "allocation", ENOMEM);
    size_t offset = 0;
    while (valid && offset < size) {
        const ssize_t count = read(fd, bytes + offset, size - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) { valid = client_failure(check, "read", count < 0 ? errno : EIO); break; }
        offset += (size_t)count;
    }
    unsigned char digest[CC_SHA256_DIGEST_LENGTH]; char hex[CC_SHA256_DIGEST_LENGTH * 2 + 1];
    if (valid) {
        (void)CC_SHA256(bytes, (CC_LONG)size, digest);
        for (size_t i = 0; i < sizeof(digest); ++i) (void)snprintf(hex + i * 2, 3, "%02x", digest[i]);
        if (strcmp(hex, RELAY_PROBE_CLIENT_SHA256) != 0) valid = client_failure(check, "digest", EBADMSG);
        else if (fstat(fd, &after) != 0) valid = client_failure(check, "fstat_after", errno);
        else if (lstat(RELAY_PROBE_CLIENT_PATH, &final) != 0) valid = client_failure(check, "lstat_after", errno);
        else if (!same_file(&opened, &after) || !same_file(&after, &final)) valid = client_failure(check, "final_identity", ESTALE);
    }
    free(bytes);
    if (close(fd) != 0) {
        check->close_error = errno;
        if (valid) valid = client_failure(check, "close", check->close_error);
    }
    if (valid) check->stage = "passed";
    return valid;
}
static bool make_pipe(int descriptors[2], bool nonblock_write) {
    if (pipe(descriptors) != 0) return false;
    return fcntl(descriptors[0], F_SETFD, FD_CLOEXEC) == 0 && fcntl(descriptors[1], F_SETFD, FD_CLOEXEC) == 0 &&
        (!nonblock_write || fcntl(descriptors[1], F_SETFL, O_NONBLOCK) == 0);
}
static bool high_copy(int *fd) {
    const int copy = fcntl(*fd, F_DUPFD_CLOEXEC, 10);
    if (copy < 10) return false;
    const int old = *fd; *fd = copy;
    return close(old) == 0;
}
static bool fd_inventory(struct proc_fdinfo entries[FD_LIMIT], size_t *count) {
    const int capacity = (int)(sizeof(*entries) * FD_LIMIT);
    const int needed = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, NULL, 0);
    if (needed <= 0 || needed > capacity) return false;
    const int received = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, entries, capacity);
    if (received <= 0 || received % (int)sizeof(*entries) != 0 || received >= capacity) return false;
    *count = (size_t)received / sizeof(*entries); return true;
}
static void child_exec(int delivery, int input, int output, int null_fd,
                       const struct proc_fdinfo *entries, size_t count) {
    /* All sources are distinct >=10 copies allocated before the complete
     * parent FD snapshot. No thread or new FD exists between snapshot/fork. */
    if (dup2(input, 0) < 0 || dup2(output, 1) < 0 || dup2(null_fd, 2) < 0 || dup2(delivery, 3) < 0) _exit(112);
    for (size_t i = 0; i < count; ++i) {
        if (entries[i].proc_fd > 3 && close(entries[i].proc_fd) != 0) _exit(118);
    }
    gid_t group = RELAY_PROBE_CLIENT_GID;
    if (setgroups(1, &group) != 0 || setgid(group) != 0 || setuid(RELAY_PROBE_CLIENT_UID) != 0 ||
        getuid() != RELAY_PROBE_CLIENT_UID || geteuid() != RELAY_PROBE_CLIENT_UID ||
        getgid() != group || getegid() != group) _exit(113);
    gid_t actual[2];
    if (getgroups(2, actual) != 1 || actual[0] != group) _exit(114);
    struct sigaction standard; memset(&standard, 0, sizeof(standard)); standard.sa_handler = SIG_DFL;
    (void)sigemptyset(&standard.sa_mask);
    if (sigaction(SIGPIPE, &standard, NULL) != 0 || sigaction(SIGINT, &standard, NULL) != 0 ||
        sigaction(SIGTERM, &standard, NULL) != 0) _exit(115);
    sigset_t mask; (void)sigemptyset(&mask); if (sigprocmask(SIG_SETMASK, &mask, NULL) != 0) _exit(116);
    char *const args[] = {(char *)RELAY_PROBE_CLIENT_PATH, RELAY_PROBE_CLIENT_ARGUMENT, NULL};
    char *const environment[] = {"PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", NULL};
    execve(RELAY_PROBE_CLIENT_PATH, args, environment); _exit(117);
}
static bool reap_nonblocking(pid_t child, Report *r) {
    const pid_t result = waitpid(child, &r->child_wait_status, WNOHANG);
    if (result == child) { r->child_exited = true; return true; }
    if (result == 0 || (result < 0 && errno == EINTR)) return true;
    r->system_error = errno; return false;
}
static bool collect_child(pid_t child, int output, Report *r) {
    char bytes[OUTPUT_LIMIT]; size_t used = 0; bool eof = false, invalid = false;
    const uint64_t start = now_ns();
    if (start == 0 || fcntl(output, F_SETFL, O_NONBLOCK) != 0) { invalid = true; r->system_error = errno; }
    while (!invalid && (!r->child_exited || !eof)) {
        if (!eof) {
            char next[512]; const ssize_t n = read(output, next, sizeof(next));
            if (n > 0) {
                if ((size_t)n > OUTPUT_LIMIT - used) { invalid = true; break; }
                memcpy(bytes + used, next, (size_t)n); used += (size_t)n;
            } else if (n == 0) eof = true;
            else if (errno != EAGAIN && errno != EINTR) { invalid = true; r->system_error = errno; break; }
        }
        if (!r->child_exited && !reap_nonblocking(child, r)) { invalid = true; break; }
        const uint64_t now = now_ns();
        if (now == 0 || now < start || now - start > RELAY_PROBE_TIMEOUT_NS) { invalid = true; r->child_timed_out = true; break; }
        if (eof && !r->child_exited) { const struct timespec pause = {.tv_nsec = 10000000}; (void)nanosleep(&pause, NULL); }
        else if (!eof) { struct pollfd p = {.fd = output, .events = POLLIN}; (void)poll(&p, 1, 10); }
    }
#if RELAY_PROBE_CORE_TEST
    if (!r->child_exited && reap_nonblocking(child, r) && !r->child_exited) {
        /* The core fixture owns a second ordinary-UID child. Allow its signal
         * handler to run the bounded <=5s core shutdown before escalating.
         * A timeout remains failure even if that cleanup finishes normally. */
        (void)kill(child, SIGTERM);
        const uint64_t graceful_start = now_ns();
        for (unsigned int attempt = 0; attempt < 650 && !r->child_exited; ++attempt) {
            if (!reap_nonblocking(child, r)) break;
            const uint64_t now = now_ns();
            if (now == 0 || graceful_start == 0 || now < graceful_start ||
                now - graceful_start >= UINT64_C(6000000000)) break;
            const struct timespec pause = {.tv_nsec = 10000000}; (void)nanosleep(&pause, NULL);
        }
    }
#endif
    if (!r->child_exited && reap_nonblocking(child, r) && !r->child_exited) {
        /* Only this call's unreaped direct child can be signalled. Never adopt
         * a stored PID. Even the post-SIGKILL reap has a bounded deadline. */
        (void)kill(child, SIGKILL);
        const uint64_t stop = now_ns();
        for (unsigned int attempt = 0; attempt < 100 && !r->child_exited; ++attempt) {
            if (!reap_nonblocking(child, r)) break;
            const uint64_t now = now_ns();
            if (now == 0 || now < stop || now - stop >= UINT64_C(1000000000)) break;
            const struct timespec pause = {.tv_nsec = 10000000}; (void)nanosleep(&pause, NULL);
        }
    }
    memcpy(r->child_output, bytes, used); r->child_output_length = used;
    return !invalid && r->child_exited && eof && WIFEXITED(r->child_wait_status) && WEXITSTATUS(r->child_wait_status) == 0 &&
        used == sizeof(success_reply) - 1 && memcmp(bytes, success_reply, used) == 0;
}
static bool sample_absence(const RelayTunDeviceSnapshot *identity, int *error) {
    errno = 0; struct if_nameindex *interfaces = if_nameindex();
    if (interfaces == NULL) { *error = errno ? errno : EIO; return false; }
    bool present = false, collision = false, complete = false;
    for (size_t i = 0; i < FD_LIMIT; ++i) {
        const struct if_nameindex entry = interfaces[i];
        if (entry.if_index == 0 && entry.if_name == NULL) { complete = true; break; }
        if (entry.if_index == 0 || entry.if_name == NULL) { *error = EINVAL; break; }
        const bool name = strcmp(entry.if_name, identity->name) == 0, index = entry.if_index == identity->interface_index;
        if (name && index) present = true; else if (name || index) collision = true;
    }
    if_freenameindex(interfaces);
    if (!complete || collision) { *error = collision ? ESTALE : EOVERFLOW; return false; }
    *error = 0; return !present;
}
static void report_json(const Report *r) {
    printf("{\"version\":1,\"status\":\"%s\",\"privilegedBranchExecuted\":%s,\"clientPinnedBeforeCreate\":%s,\"clientPinRechecked\":%s,"
        "\"createAttempted\":%s,\"created\":%s,\"identityObserved\":%s,\"identity\":",
        r->status, r->privileged ? "true" : "false", r->client_verified ? "true" : "false", r->client_reverified ? "true" : "false",
        r->create_attempted ? "true" : "false", r->created ? "true" : "false", r->observed ? "true" : "false");
    if (r->observed) printf("{\"name\":\"%s\",\"index\":%u,\"controlID\":%u,\"controlUnit\":%u,\"mtu\":%u}",
        r->identity.name, r->identity.interface_index, r->identity.control_id, r->identity.control_unit, r->identity.mtu);
    else fputs("null", stdout);
    printf(",\"readOnlyClientCheck\":%s,\"clientCheckBefore\":{\"stage\":\"%s\",\"errno\":%d,\"closeErrno\":%d},"
        "\"clientCheckAfter\":{\"stage\":\"%s\",\"errno\":%d,\"closeErrno\":%d}", r->read_only ? "true" : "false",
        r->client_before.stage ? r->client_before.stage : "not_run", r->client_before.system_error, r->client_before.close_error,
        r->client_after.stage ? r->client_after.stage : "not_run", r->client_after.system_error, r->client_after.close_error);
    printf(",\"deliveryDuplicated\":%s,\"parentDeliveryClosed\":%s,\"childForked\":%s,\"childExited\":%s,\"childWaitStatus\":%d,"
        "\"childTimedOut\":%s,\"childReportValidated\":%s,\"childReportedOrdinaryUID\":%s,\"childReportedReceiptBinding\":%s,"
        "\"childReportedFDClosed\":%s,\"primaryCloseAttempted\":%s,\"primaryCloseSucceeded\":%s,\"primaryHandleReleased\":%s,"
        "\"absenceChecked\":%s,\"deviceAbsentObserved\":%s,\"absenceChecks\":%u,\"absenceError\":%d,\"systemError\":%d,"
        "\"deviceError\":{\"code\":%u,\"stage\":%u,\"errno\":%d,\"networkMayHaveChanged\":%s},\"physicalCrossUIDProbe\":true,"
        "\"authenticatedMachTransfer\":false,\"actualTunAccepted\":false,\"baselineRestorationVerified\":false,"
        "\"explicitConfigurationWrites\":false,\"coreStarted\":%s,\"coreAdoptionProbe\":%s,\"deviceCallCounters\":",
        r->duplicated ? "true" : "false", r->parent_delivery_closed ? "true" : "false", r->forked ? "true" : "false",
        r->child_exited ? "true" : "false", r->child_wait_status, r->child_timed_out ? "true" : "false",
        r->child_report_validated ? "true" : "false", r->child_report_validated ? "true" : "false",
        r->child_report_validated ? "true" : "false", r->child_report_validated ? "true" : "false",
        r->primary_close_attempted ? "true" : "false", r->primary_closed ? "true" : "false", r->primary_released ? "true" : "false",
        r->absence_checked ? "true" : "false", r->absent ? "true" : "false", r->absence_checks, r->absence_error, r->system_error,
        (unsigned int)r->device_error.code, (unsigned int)r->device_error.stage, r->device_error.system_error,
        r->device_error.network_may_have_changed ? "true" : "false",
        RELAY_PROBE_CORE_TEST ? (r->child_report_validated ? "true" : (r->forked ? "null" : "false")) : "false",
        RELAY_PROBE_CORE_TEST ? "true" : "false");
#ifdef RELAY_TUN_DEVICE_TESTING
    const RelayTunDeviceTestCounters c = relay_tun_device_test_counters();
    printf("{\"socket\":%llu,\"ioctl\":%llu,\"connect\":%llu,\"observe\":%llu,\"fd\":%llu,\"close\":%llu}",
        (unsigned long long)c.socket_calls, (unsigned long long)c.ioctl_calls, (unsigned long long)c.connect_calls,
        (unsigned long long)c.observe_calls, (unsigned long long)c.fd_calls, (unsigned long long)c.close_calls);
#else
    fputs("null", stdout);
#endif
    fputs(",\"childOutputHex\":\"", stdout);
    for (size_t i = 0; i < r->child_output_length; ++i) printf("%02x", (unsigned char)r->child_output[i]);
    fputs("\"}\n", stdout);
}
int main(int argc, char **argv) {
    Report r = {.status = "refused_argument"};
    if (argc == 2 && strcmp(argv[1], "--verify-client-only") == 0) {
        /* Fixed path, exact same checks, no privilege acquisition and no call
         * into any device, descriptor-delivery, fork or child execution API. */
        r.read_only = true; r.client_verified = verify_client(&r.client_before);
        r.system_error = r.client_before.system_error;
        r.status = r.client_verified ? "read_only_client_verified" : "read_only_client_refused";
        report_json(&r); return r.client_verified ? 0 : 1;
    }
    if (argc != 2 || strcmp(argv[1], RELAY_PROBE_ACTION) != 0) { report_json(&r); return 64; }
    if (getuid() != 0 || geteuid() != 0 || RELAY_PROBE_CLIENT_UID == 0) { r.status = "refused_permission"; report_json(&r); return 77; }
#ifdef RELAY_TUN_DESCRIPTOR_PROBE_PERMISSION_TESTS
    r.status = "refused_test_binary"; report_json(&r); return 77;
#endif
    r.privileged = true;
    if (!(r.client_verified = verify_client(&r.client_before))) {
        r.status = "client_pin_refused"; r.system_error = r.client_before.system_error; report_json(&r); return 1;
    }
    struct sigaction ignore; memset(&ignore, 0, sizeof(ignore)); ignore.sa_handler = SIG_IGN;
    (void)sigemptyset(&ignore.sa_mask);
    if (sigaction(SIGPIPE, &ignore, NULL) != 0) { r.status = "signal_setup_failed"; r.system_error = errno; report_json(&r); return 1; }
    RelayTunDevice *device = NULL; int delivery = -1, input[2] = {-1, -1}, output[2] = {-1, -1}, null_fd = -1;
    r.create_attempted = true;
    if (relay_tun_device_create("utun", &device, &r.device_error) != RELAY_TUN_DEVICE_OK || device == NULL) {
        r.status = "create_failed"; report_json(&r); return 1;
    }
    r.created = true;
    if (relay_tun_device_snapshot(device, &r.identity, &r.device_error) != RELAY_TUN_DEVICE_OK) { r.status = "snapshot_failed"; goto cleanup; }
    r.observed = true;
    if (relay_tun_device_duplicate_fd(device, &delivery, &r.device_error) != RELAY_TUN_DEVICE_OK) { r.status = "duplicate_failed"; goto cleanup; }
    r.duplicated = true;
    struct stat descriptor;
    if (fstat(delivery, &descriptor) != 0 || !S_ISSOCK(descriptor.st_mode)) { r.status = "delivery_stat_failed"; r.system_error = errno; goto cleanup; }
    char receipt[OUTPUT_LIMIT];
    const int receipt_length = snprintf(receipt, sizeof(receipt), "{\"version\":1,\"installationRevision\":\"%s\",\"clientUID\":%u,"
        "\"evidenceSHA256\":\"%s\",\"runtimeConfigurationSHA256\":\"%s\",\"planID\":\"a819f72d-7b78-45e5-933f-561bfa2e0f70\","
        "\"sessionID\":\"bd3e739f-2820-4be2-85ef-01286a8618c4\",\"deviceID\":\"b166222a-c6c9-473b-a09b-df5c3e631b44\","
        "\"interfaceName\":\"%s\",\"interfaceIndex\":%u,\"controlID\":%u,\"controlUnit\":%u,\"socketDevice\":\"%" PRIu64 "\",\"socketInode\":\"%" PRIu64 "\"}",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", (unsigned int)RELAY_PROBE_CLIENT_UID,
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        r.identity.name, r.identity.interface_index, r.identity.control_id, r.identity.control_unit,
        (uint64_t)descriptor.st_dev, (uint64_t)descriptor.st_ino);
    if (receipt_length <= 0 || receipt_length >= (int)sizeof(receipt) || !make_pipe(input, true) || !make_pipe(output, false) ||
        (null_fd = open("/dev/null", O_WRONLY | O_CLOEXEC)) < 0) { r.status = "pipe_setup_failed"; r.system_error = errno; goto cleanup; }
    /* Nonblocking preload cannot wedge the parent. The child sees EOF after a
     * single root-generated bounded receipt, with no commands or paths. */
    if (write(input[1], receipt, (size_t)receipt_length) != receipt_length) { r.status = "receipt_pipe_failed"; r.system_error = errno; goto cleanup; }
    if (close(input[1]) != 0) { r.status = "receipt_pipe_close_uncertain"; r.system_error = errno; input[1] = -1; goto cleanup; }
    input[1] = -1;
    if (!high_copy(&delivery) || !high_copy(&input[0]) || !high_copy(&output[1]) || !high_copy(&null_fd)) {
        r.status = "fd_mapping_preparation_failed"; r.system_error = errno; goto cleanup;
    }
    struct proc_fdinfo entries[FD_LIMIT]; size_t fd_count = 0;
    if (!fd_inventory(entries, &fd_count)) { r.status = "fd_inventory_failed"; r.system_error = errno; goto cleanup; }
    const pid_t child = fork();
    if (child < 0) { r.status = "fork_failed"; r.system_error = errno; goto cleanup; }
    if (child == 0) child_exec(delivery, input[0], output[1], null_fd, entries, fd_count);
    r.forked = true;
    if (close(delivery) == 0) r.parent_delivery_closed = true; else r.system_error = errno;
    delivery = -1;
    (void)close(output[1]); output[1] = -1;
    (void)close(input[0]); input[0] = -1;
    (void)close(null_fd); null_fd = -1;
    r.child_report_validated = collect_child(child, output[0], &r);
    r.client_reverified = verify_client(&r.client_after);
    r.status = r.child_report_validated && r.parent_delivery_closed && r.client_reverified ? "child_validated" : "child_transfer_unverified";
cleanup:
    if (delivery >= 0) { if (close(delivery) == 0) r.parent_delivery_closed = true; else r.system_error = errno; }
    for (size_t i = 0; i < 2; ++i) { if (input[i] >= 0) (void)close(input[i]); if (output[i] >= 0) (void)close(output[i]); }
    if (null_fd >= 0) (void)close(null_fd);
    if (device != NULL && (!r.forked || r.child_exited)) {
        r.primary_close_attempted = true; RelayTunDeviceError closed;
        r.primary_closed = relay_tun_device_close(&device, &closed) == RELAY_TUN_DEVICE_OK;
        if (!r.primary_closed) r.device_error = closed;
        r.primary_released = device == NULL;
    }
    if (r.observed && r.primary_released && (!r.forked || r.child_exited)) {
        r.absence_checked = true;
        for (unsigned int attempt = 0; attempt < 40; ++attempt) {
            r.absence_checks++; r.absent = sample_absence(&r.identity, &r.absence_error);
            if (r.absent || r.absence_error != 0) break;
            if (attempt < 39) { const struct timespec pause = {.tv_nsec = 125000000}; (void)nanosleep(&pause, NULL); }
        }
    }
    const bool passed = r.child_report_validated && r.parent_delivery_closed && r.client_reverified && r.primary_closed && r.primary_released && r.absent;
    if (passed) r.status = "ordinary_uid_admission_and_device_absence_observed";
    report_json(&r); return passed ? 0 : 1;
}
