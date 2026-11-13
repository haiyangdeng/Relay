#ifndef RELAY_GUARD_ES_AUDIT_H
#define RELAY_GUARD_ES_AUDIT_H

#include <bsm/libbsm.h>
#include <stdint.h>

// Use the OS accessor contract, rather than persisting or indexing token words.
static inline int32_t RelayGuardAuditPID(audit_token_t token) {
    return audit_token_to_pid(token);
}
static inline uint32_t RelayGuardAuditVersion(audit_token_t token) {
    return (uint32_t)audit_token_to_pidversion(token);
}
static inline uint32_t RelayGuardAuditEffectiveUID(audit_token_t token) {
    return audit_token_to_euid(token);
}
static inline uint32_t RelayGuardAuditRealUID(audit_token_t token) {
    return audit_token_to_ruid(token);
}

#endif
