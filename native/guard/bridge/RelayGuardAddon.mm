// Electron v43.8.0 Swift native-addon pattern, using raw Node-API instead of
// introducing node-addon-api/bindings npm dependencies. No operation runs at
// module initialization. All requests and completion values are bounded JSON.
#import <Foundation/Foundation.h>
#include <node_api.h>
#include <string>
#include <memory>
#include <atomic>
#include "RelayGuardHostBridge.h"

namespace {
std::atomic<uint64_t> intentEpoch{0};
std::atomic<uint64_t> maintenanceEpoch{0};
std::atomic<uint64_t> storageEpoch{0};
struct Request {
    napi_deferred deferred;
    napi_threadsafe_function completion;
};
void Finish(napi_env env, napi_value, void* context, void* data) {
    std::unique_ptr<std::string> result(static_cast<std::string*>(data));
    auto* request = static_cast<Request*>(context);
    if (!env || !result) return; // Environment teardown owns JS promises.
    napi_value value;
    if (napi_create_string_utf8(env, result->data(), result->size(), &value) == napi_ok)
        napi_resolve_deferred(env, request->deferred, value);
}
void Finalize(napi_env, void* context, void*) { delete static_cast<Request*>(context); }
napi_value Invoke(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2], promise;
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1) {
        napi_throw_type_error(env, nullptr, "One bounded Guard JSON request is required");
        return nullptr;
    }
    napi_valuetype type;
    size_t length = 0;
    if (napi_typeof(env, args[0], &type) != napi_ok || type != napi_string ||
        napi_get_value_string_utf8(env, args[0], nullptr, 0, &length) != napi_ok ||
        length == 0 || length > 3 * 1024 * 1024) {
        napi_throw_type_error(env, nullptr, "Invalid Guard request type or size");
        return nullptr;
    }
    std::string input(length + 1, '\0');
    if (napi_get_value_string_utf8(env, args[0], input.data(), input.size(), &length) != napi_ok) return nullptr;
    auto* request = new Request{};
    napi_value name;
    if (napi_create_promise(env, &request->deferred, &promise) != napi_ok ||
        napi_create_string_utf8(env, "RelayGuardCompletion", NAPI_AUTO_LENGTH, &name) != napi_ok ||
        napi_create_threadsafe_function(env, nullptr, nullptr, name, 1, 1,
            request, Finalize, request, Finish, &request->completion) != napi_ok) {
        delete request;
        napi_throw_error(env, nullptr, "Guard callback allocation failed");
        return nullptr;
    }
    NSString* text = [[NSString alloc] initWithBytes:input.data() length:length encoding:NSUTF8StringEncoding];
    if (!text) {
        napi_release_threadsafe_function(request->completion, napi_tsfn_abort);
        napi_throw_type_error(env, nullptr, "Guard request is not UTF-8");
        return nullptr;
    }
    const uint64_t epoch = intentEpoch.load();
    [RelayGuardHostBridge request:text validity:^BOOL { return intentEpoch.load() == epoch; } completion:^(NSString* value) {
        NSData* bytes = [value dataUsingEncoding:NSUTF8StringEncoding];
        auto result = std::make_unique<std::string>();
        if (bytes && bytes.length <= 16384) result->assign(static_cast<const char*>(bytes.bytes), bytes.length);
        else result->assign("{\"version\":1,\"error\":\"oversizedReply\"}");
        if (napi_call_threadsafe_function(request->completion, result.get(), napi_tsfn_nonblocking) == napi_ok)
            result.release();
        napi_release_threadsafe_function(request->completion, napi_tsfn_release);
    }];
    return promise;
}
napi_value InvokeMaintenance(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2], promise;
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1) {
        napi_throw_type_error(env, nullptr, "One bounded Guard JSON request is required");
        return nullptr;
    }
    napi_valuetype type;
    size_t length = 0;
    if (napi_typeof(env, args[0], &type) != napi_ok || type != napi_string ||
        napi_get_value_string_utf8(env, args[0], nullptr, 0, &length) != napi_ok ||
        length == 0 || length > 65536) {
        napi_throw_type_error(env, nullptr, "Invalid Guard request type or size");
        return nullptr;
    }
    std::string input(length + 1, '\0');
    if (napi_get_value_string_utf8(env, args[0], input.data(), input.size(), &length) != napi_ok) return nullptr;
    auto* request = new Request{};
    napi_value name;
    if (napi_create_promise(env, &request->deferred, &promise) != napi_ok ||
        napi_create_string_utf8(env, "RelayGuardCompletion", NAPI_AUTO_LENGTH, &name) != napi_ok ||
        napi_create_threadsafe_function(env, nullptr, nullptr, name, 1, 1,
            request, Finalize, request, Finish, &request->completion) != napi_ok) {
        delete request;
        napi_throw_error(env, nullptr, "Guard callback allocation failed");
        return nullptr;
    }
    NSString* text = [[NSString alloc] initWithBytes:input.data() length:length encoding:NSUTF8StringEncoding];
    if (!text) {
        napi_release_threadsafe_function(request->completion, napi_tsfn_abort);
        napi_throw_type_error(env, nullptr, "Guard request is not UTF-8");
        return nullptr;
    }
    const uint64_t epoch = maintenanceEpoch.load();
    [RelayMaintenanceHostBridge request:text validity:^BOOL { return maintenanceEpoch.load() == epoch; } completion:^(NSString* value) {
        NSData* bytes = [value dataUsingEncoding:NSUTF8StringEncoding];
        auto result = std::make_unique<std::string>();
        if (bytes && bytes.length <= 16384) result->assign(static_cast<const char*>(bytes.bytes), bytes.length);
        else result->assign("{\"version\":1,\"error\":\"oversizedReply\"}");
        if (napi_call_threadsafe_function(request->completion, result.get(), napi_tsfn_nonblocking) == napi_ok)
            result.release();
        napi_release_threadsafe_function(request->completion, napi_tsfn_release);
    }];
    return promise;
}
napi_value InvokeStorage(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2], promise;
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1) {
        napi_throw_type_error(env, nullptr, "One bounded Guard JSON request is required");
        return nullptr;
    }
    napi_valuetype type;
    size_t length = 0;
    if (napi_typeof(env, args[0], &type) != napi_ok || type != napi_string ||
        napi_get_value_string_utf8(env, args[0], nullptr, 0, &length) != napi_ok ||
        length == 0 || length > 4096) {
        napi_throw_type_error(env, nullptr, "Invalid Guard request type or size");
        return nullptr;
    }
    std::string input(length + 1, '\0');
    if (napi_get_value_string_utf8(env, args[0], input.data(), input.size(), &length) != napi_ok) return nullptr;
    auto* request = new Request{};
    napi_value name;
    if (napi_create_promise(env, &request->deferred, &promise) != napi_ok ||
        napi_create_string_utf8(env, "RelayGuardCompletion", NAPI_AUTO_LENGTH, &name) != napi_ok ||
        napi_create_threadsafe_function(env, nullptr, nullptr, name, 1, 1,
            request, Finalize, request, Finish, &request->completion) != napi_ok) {
        delete request;
        napi_throw_error(env, nullptr, "Guard callback allocation failed");
        return nullptr;
    }
    NSString* text = [[NSString alloc] initWithBytes:input.data() length:length encoding:NSUTF8StringEncoding];
    if (!text) {
        napi_release_threadsafe_function(request->completion, napi_tsfn_abort);
        napi_throw_type_error(env, nullptr, "Guard request is not UTF-8");
        return nullptr;
    }
    const uint64_t epoch = storageEpoch.load();
    [RelayScopedStorageHostBridge request:text validity:^BOOL { return storageEpoch.load() == epoch; } completion:^(NSString* value) {
        NSData* bytes = [value dataUsingEncoding:NSUTF8StringEncoding];
        auto result = std::make_unique<std::string>();
        if (bytes && bytes.length <= 32768) result->assign(static_cast<const char*>(bytes.bytes), bytes.length);
        else result->assign("{\"version\":1,\"error\":\"oversizedReply\"}");
        if (napi_call_threadsafe_function(request->completion, result.get(), napi_tsfn_nonblocking) == napi_ok)
            result.release();
        napi_release_threadsafe_function(request->completion, napi_tsfn_release);
    }];
    return promise;
}
napi_value InvokeTerminalLease(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2], promise;
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1) {
        napi_throw_type_error(env, nullptr, "One bounded Terminal lease request is required");
        return nullptr;
    }
    napi_valuetype type;
    size_t length = 0;
    if (napi_typeof(env, args[0], &type) != napi_ok || type != napi_string ||
        napi_get_value_string_utf8(env, args[0], nullptr, 0, &length) != napi_ok ||
        length == 0 || length > 16384) {
        napi_throw_type_error(env, nullptr, "Invalid Terminal lease request type or size");
        return nullptr;
    }
    std::string input(length + 1, '\0');
    if (napi_get_value_string_utf8(env, args[0], input.data(), input.size(), &length) != napi_ok) return nullptr;
    NSString* text = [[NSString alloc] initWithBytes:input.data() length:length encoding:NSUTF8StringEncoding];
    if (!text) {
        napi_throw_type_error(env, nullptr, "Terminal lease request is not UTF-8");
        return nullptr;
    }
    auto* request = new Request{};
    napi_value name;
    if (napi_create_promise(env, &request->deferred, &promise) != napi_ok ||
        napi_create_string_utf8(env, "RelayTerminalLeaseCompletion", NAPI_AUTO_LENGTH, &name) != napi_ok ||
        napi_create_threadsafe_function(env, nullptr, nullptr, name, 1, 1,
            request, Finalize, request, Finish, &request->completion) != napi_ok) {
        delete request;
        napi_throw_error(env, nullptr, "Terminal lease callback allocation failed");
        return nullptr;
    }
    const napi_threadsafe_function handle = request->completion;
    if (napi_unref_threadsafe_function(env, handle) != napi_ok) {
        napi_release_threadsafe_function(handle, napi_tsfn_abort);
        napi_throw_error(env, nullptr, "Terminal lease callback could not be attached");
        return nullptr;
    }
    [RelayTerminalLeaseHostBridge request:text completion:^(NSString* value) {
        NSData* bytes = [value dataUsingEncoding:NSUTF8StringEncoding];
        auto result = std::make_unique<std::string>();
        if (bytes && bytes.length <= 16384) result->assign(static_cast<const char*>(bytes.bytes), bytes.length);
        else result->assign("{\"version\":1,\"action\":\"invalid\",\"ok\":false,\"reason\":\"invalid\"}");
        const napi_status delivered = napi_call_threadsafe_function(handle, result.get(), napi_tsfn_nonblocking);
        if (delivered == napi_ok) result.release();
        // A closing TSFN no longer admits this producer. No further handle
        // operation is valid after the closing result.
        if (delivered != napi_closing) napi_release_threadsafe_function(handle, napi_tsfn_release);
    }];
    return promise;
}
void InvalidateTerminalLease(void*) { [RelayTerminalLeaseHostBridge invalidate]; }
napi_value Invalidate(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argument, result;
    if (napi_get_cb_info(env, info, &argc, &argument, nullptr, nullptr) != napi_ok || argc != 0) {
        napi_throw_type_error(env, nullptr, "Intent invalidation takes no arguments"); return nullptr;
    }
    intentEpoch.fetch_add(1);
    napi_get_undefined(env, &result); return result;
}
napi_value InvalidateMaintenance(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argument, result;
    if (napi_get_cb_info(env, info, &argc, &argument, nullptr, nullptr) != napi_ok || argc != 0) {
        napi_throw_type_error(env, nullptr, "Intent invalidation takes no arguments"); return nullptr;
    }
    maintenanceEpoch.fetch_add(1);
    napi_get_undefined(env, &result); return result;
}
napi_value InvalidateStorage(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argument, result;
    if (napi_get_cb_info(env, info, &argc, &argument, nullptr, nullptr) != napi_ok || argc != 0) {
        napi_throw_type_error(env, nullptr, "Intent invalidation takes no arguments"); return nullptr;
    }
    storageEpoch.fetch_add(1);
    napi_get_undefined(env, &result); return result;
}
napi_value Initialize(napi_env env, napi_value exports) {
    napi_property_descriptor property = {"request", nullptr, Invoke, nullptr, nullptr, nullptr, napi_default, nullptr};
    if (napi_define_properties(env, exports, 1, &property) != napi_ok) return nullptr;
    napi_property_descriptor invalidate = {"invalidateIntents", nullptr, Invalidate, nullptr, nullptr, nullptr, napi_default, nullptr};
    if (napi_define_properties(env, exports, 1, &invalidate) != napi_ok) return nullptr;
    napi_property_descriptor maintenance = {"maintenance", nullptr, InvokeMaintenance, nullptr, nullptr, nullptr, napi_default, nullptr};
    napi_property_descriptor invalidateMaintenance = {"invalidateMaintenanceIntents", nullptr, InvalidateMaintenance, nullptr, nullptr, nullptr, napi_default, nullptr};
    if (napi_define_properties(env, exports, 1, &maintenance) != napi_ok || napi_define_properties(env, exports, 1, &invalidateMaintenance) != napi_ok) return nullptr;
    napi_property_descriptor storage = {"scopedStorage", nullptr, InvokeStorage, nullptr, nullptr, nullptr, napi_default, nullptr};
    napi_property_descriptor invalidateStorage = {"invalidateScopedStorageIntents", nullptr, InvalidateStorage, nullptr, nullptr, nullptr, napi_default, nullptr};
    if (napi_define_properties(env, exports, 1, &storage) != napi_ok || napi_define_properties(env, exports, 1, &invalidateStorage) != napi_ok) return nullptr;
    napi_property_descriptor terminalLease = {"terminalLease", nullptr, InvokeTerminalLease, nullptr, nullptr, nullptr, napi_default, nullptr};
    if (napi_define_properties(env, exports, 1, &terminalLease) != napi_ok ||
        napi_add_env_cleanup_hook(env, InvalidateTerminalLease, nullptr) != napi_ok) return nullptr;
    return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
