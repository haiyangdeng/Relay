#include "RelayTunDevice.h"

#include <errno.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

/* One fixed, explicitly authorized administrator smoke action. This program
 * does not install a helper, configure an interface, pass/duplicate a descriptor,
 * run a core, send packets or write routes/DNS. Merely creating utun can have
 * kernel-visible effects; success is never a claim of baseline restoration.
 * No name, path, PID, executable, command or environment authority is accepted. */
typedef struct {
    const char *status;
    bool privileged, create_attempted, created, identity_observed;
    RelayTunDeviceSnapshot identity;
    RelayTunDeviceError create_error, snapshot_error, close_error;
    bool close_attempted, close_succeeded, primary_released;
    bool absence_checked, device_absent;
    unsigned int absence_checks;
    int absence_error;
    bool possible_network_change;
} ProbeReport;

static void error_json(const RelayTunDeviceError *error) {
    if (error->code == RELAY_TUN_DEVICE_OK) { fputs("null", stdout); return; }
    printf("{\"code\":%u,\"stage\":%u,\"errno\":%d,\"networkMayHaveChanged\":%s}",
           (unsigned int)error->code, (unsigned int)error->stage, error->system_error,
           error->network_may_have_changed ? "true" : "false");
}

static void report_json(const ProbeReport *report) {
    printf("{\"version\":1,\"status\":\"%s\",\"privilegedBranchExecuted\":%s,"
           "\"createAttempted\":%s,\"created\":%s,\"identityObserved\":%s,\"identity\":",
           report->status, report->privileged ? "true" : "false",
           report->create_attempted ? "true" : "false", report->created ? "true" : "false",
           report->identity_observed ? "true" : "false");
    if (report->identity_observed) {
        /* The backend accepts only a strict utunN kernel name, so no arbitrary
         * caller or environment string reaches this JSON string position. */
        printf("{\"name\":\"%s\",\"index\":%u,\"controlID\":%u,\"controlUnit\":%u,\"mtu\":%u}",
               report->identity.name, report->identity.interface_index, report->identity.control_id,
               report->identity.control_unit, report->identity.mtu);
    } else fputs("null", stdout);
    fputs(",\"createError\":", stdout); error_json(&report->create_error);
    fputs(",\"snapshotError\":", stdout); error_json(&report->snapshot_error);
    printf(",\"closeAttempted\":%s,\"closeSucceeded\":%s,\"primaryHandleReleased\":%s,\"closeError\":",
           report->close_attempted ? "true" : "false", report->close_succeeded ? "true" : "false",
           report->primary_released ? "true" : "false");
    error_json(&report->close_error);
    printf(",\"absenceChecked\":%s,\"deviceAbsentObserved\":%s,\"absenceChecks\":%u,\"absenceError\":%d,"
           "\"possibleNetworkChange\":%s,\"explicitConfigurationWrites\":false,\"descriptorExported\":false,"
           "\"baselineRestorationVerified\":false,\"actualTunAccepted\":false,\"deviceCallCounters\":",
           report->absence_checked ? "true" : "false", report->device_absent ? "true" : "false",
           report->absence_checks, report->absence_error, report->possible_network_change ? "true" : "false");
#ifdef RELAY_TUN_DEVICE_TESTING
    const RelayTunDeviceTestCounters counters = relay_tun_device_test_counters();
    printf("{\"socket\":%llu,\"ioctl\":%llu,\"connect\":%llu,\"observe\":%llu,\"fd\":%llu,\"close\":%llu}",
           (unsigned long long)counters.socket_calls, (unsigned long long)counters.ioctl_calls,
           (unsigned long long)counters.connect_calls, (unsigned long long)counters.observe_calls,
           (unsigned long long)counters.fd_calls, (unsigned long long)counters.close_calls);
#else
    fputs("null", stdout);
#endif
    fputs("}\n", stdout);
}

/* An absence sample is independent of closing the held primary handle. Both
 * the old name and the old index must be missing; any replacement/collision or
 * observation failure is uncertainty, never authority to delete by name. */
static bool sample_absence(const RelayTunDeviceSnapshot *identity, int *error) {
    errno = 0;
    struct if_nameindex *interfaces = if_nameindex();
    if (interfaces == NULL) { *error = errno ? errno : EIO; return false; }
    bool present = false, collision = false, complete = false;
    for (size_t i = 0; i < 4096; ++i) {
        const struct if_nameindex entry = interfaces[i];
        if (entry.if_index == 0 && entry.if_name == NULL) { complete = true; break; }
        if (entry.if_index == 0 || entry.if_name == NULL) { *error = EINVAL; break; }
        const bool same_name = strcmp(entry.if_name, identity->name) == 0;
        const bool same_index = entry.if_index == identity->interface_index;
        if (same_name && same_index) present = true;
        else if (same_name || same_index) collision = true;
    }
    if_freenameindex(interfaces);
    if (!complete) { if (*error == 0) *error = EOVERFLOW; return false; }
    if (collision) { *error = ESTALE; return false; }
    *error = 0;
    return !present;
}

int main(int argc, char *argv[]) {
    ProbeReport report = {.status = "refused_argument"};
    if (argc != 2 || strcmp(argv[1], "--create-unconfigured-device-and-release") != 0) {
        report_json(&report); return 64;
    }
    if (getuid() != 0 || geteuid() != 0) {
        report.status = "refused_permission"; report_json(&report); return 77;
    }
#ifdef RELAY_TUN_DEVICE_PROBE_PERMISSION_TESTS
    /* The instrumented refusal runner cannot enter the live branch, even if
     * somebody later invokes that test executable with administrator rights. */
    report.status = "refused_test_binary"; report_json(&report); return 77;
#endif
    report.privileged = true; report.create_attempted = true;
    RelayTunDevice *device = NULL;
    RelayTunDeviceCode created = relay_tun_device_create("utun", &device, &report.create_error);
    report.possible_network_change = created == RELAY_TUN_DEVICE_OK || report.create_error.network_may_have_changed;
    if (created != RELAY_TUN_DEVICE_OK || device == NULL) {
        /* Failed creation may already have closed a partially-created device.
         * There is no known identity to adopt or clean up by speculative name. */
        report.status = "create_failed"; report_json(&report); return 1;
    }
    report.created = true;
    report.identity_observed = relay_tun_device_snapshot(device, &report.identity, &report.snapshot_error) == RELAY_TUN_DEVICE_OK;
    report.close_attempted = true;
    report.close_succeeded = relay_tun_device_close(&device, &report.close_error) == RELAY_TUN_DEVICE_OK;
    report.primary_released = device == NULL;
    if (report.identity_observed && report.primary_released) {
        report.absence_checked = true;
        for (unsigned int attempt = 0; attempt < 40; ++attempt) {
            report.absence_checks++;
            report.device_absent = sample_absence(&report.identity, &report.absence_error);
            if (report.device_absent || report.absence_error != 0) break;
            if (attempt < 39) {
                const struct timespec pause = {.tv_sec = 0, .tv_nsec = 125000000};
                (void)nanosleep(&pause, NULL);
            }
        }
    }
    if (!report.identity_observed) report.status = "identity_observation_failed";
    else if (!report.close_succeeded || !report.primary_released) report.status = "close_uncertain";
    else if (!report.device_absent) report.status = "absence_unverified";
    else report.status = "device_released_absence_observed";
    report_json(&report);
    /* If close refused identity, the process still owns the original opaque
     * handle. Exiting lets the OS close this process's descriptors; it never
     * signals another process, retries a released FD or destroys by name. */
    return strcmp(report.status, "device_released_absence_observed") == 0 ? 0 : 1;
}
