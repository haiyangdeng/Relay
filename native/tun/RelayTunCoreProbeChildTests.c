/* Own ordinary-UID inert children only. No core/device call is made. */
#define main relay_tun_descriptor_probe_program_main
#include "RelayTunDescriptorProbe.c"
#undef main

static volatile sig_atomic_t cleanup_requested;
static void cleanup_signal(int value) { cleanup_requested = value; }
static bool timed_out_inert_child(bool cooperative) {
    int output[2];
    if (pipe(output) != 0) return false;
    const pid_t child = fork();
    if (child < 0) { close(output[0]); close(output[1]); return false; }
    if (child == 0) {
        close(output[0]);
        struct sigaction action; memset(&action, 0, sizeof(action));
        action.sa_handler = cooperative ? cleanup_signal : SIG_IGN;
        sigemptyset(&action.sa_mask);
        if (sigaction(SIGTERM, &action, NULL) != 0) _exit(70);
        const char started = 'x';
        if (write(output[1], &started, 1) != 1) _exit(71);
        while (!cleanup_requested) {
            const struct timespec pause = {.tv_nsec = 1000000};
            (void)nanosleep(&pause, NULL);
        }
        /* Stand in for the client's own bounded core cleanup after TERM. */
        const struct timespec cleanup = {.tv_nsec = 50000000};
        (void)nanosleep(&cleanup, NULL);
        close(output[1]); _exit(0);
    }
    close(output[1]);
    char started = 0;
    const ssize_t received = read(output[0], &started, 1);
    Report report = {0};
    const uint64_t start = now_ns();
    const bool accepted = collect_child(child, output[0], &report);
    const uint64_t duration = now_ns() - start;
    close(output[0]);
    if (received != 1 || started != 'x' || accepted || !report.child_timed_out || !report.child_exited) return false;
    if (cooperative) return WIFEXITED(report.child_wait_status) && WEXITSTATUS(report.child_wait_status) == 0 &&
        duration >= UINT64_C(50000000) && duration < UINT64_C(6000000000);
    return WIFSIGNALED(report.child_wait_status) && WTERMSIG(report.child_wait_status) == SIGKILL &&
        duration >= UINT64_C(6000000000) && duration < UINT64_C(9500000000);
}
int main(int argc, char **argv) {
    (void)argv;
    if (argc != 1 || getuid() == 0 || geteuid() != getuid()) return 77;
    const bool cooperative = timed_out_inert_child(true), unresponsive = timed_out_inert_child(false);
    const RelayTunDeviceTestCounters counters = relay_tun_device_test_counters();
    const bool no_device_calls = counters.socket_calls == 0 && counters.ioctl_calls == 0 &&
        counters.connect_calls == 0 && counters.observe_calls == 0 && counters.fd_calls == 0 && counters.close_calls == 0;
    printf("{\"passed\":%s,\"termAllowsOwnedClientCleanup\":%s,\"unresponsiveOwnedClientBounded\":%s,"
        "\"deviceCallsZero\":%s,\"coreStarted\":false,\"actualTunCreated\":false}\n",
        cooperative && unresponsive && no_device_calls ? "true" : "false", cooperative ? "true" : "false",
        unresponsive ? "true" : "false", no_device_calls ? "true" : "false");
    return cooperative && unresponsive && no_device_calls ? 0 : 1;
}
