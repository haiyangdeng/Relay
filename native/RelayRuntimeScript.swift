import Foundation
import JavaScriptCore
import Darwin

/// Bare JavaScriptCore has no Node, DOM, file, socket, WebRTC or host bridge.
/// Execute only in the dedicated, parent-timed worker process, never the App.
enum RelayRuntimeScript {
    struct Input: Decodable {
        let script: String
        let configuration: String
    }
    enum Failure: Error { case invalidInput, rejected }

    static let readyV2 = Data("relay-runtime-script-ready-v2\n".utf8)

    /// Prepare only trusted VM state; no input or untrusted JavaScript has been
    /// consumed before the ready frame is synchronously written to stdout.
    static func prepareContext() throws -> JSContext {
        guard let context = JSContext(), context.evaluateScript("void 0") != nil,
              context.exception == nil else { throw Failure.invalidInput }
        return context
    }

    /// Newmode inherited stdin is a pipe/stream with this branch as its only
    /// reader. poll then read cannot lose readiness to another consumer. No FD
    /// flags are changed: SIGKILL cannot leave a caller's shared OFD nonblocking.
    static func readInputV2() throws -> Data {
        let fd = STDIN_FILENO
        var info = stat()
        guard fstat(fd, &info) == 0 else { throw Failure.invalidInput }
        let kind = info.st_mode & mode_t(S_IFMT)
        if kind == mode_t(S_IFSOCK) {
            var type: Int32 = 0, size = socklen_t(MemoryLayout<Int32>.size)
            guard getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &size) == 0,
                  type == SOCK_STREAM else { throw Failure.invalidInput }
        } else if kind != mode_t(S_IFIFO) { throw Failure.invalidInput }
        let start = DispatchTime.now().uptimeNanoseconds, duration: UInt64 = 3_000_000_000
        guard start <= UInt64.max - duration else { throw Failure.invalidInput }
        let deadline = start + duration, limit = 6_291_456
        var data = Data(), buffer = [UInt8](repeating: 0, count: 65_536)
        while DispatchTime.now().uptimeNanoseconds < deadline {
            var item = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let ready = poll(&item, 1, 10)
            if ready < 0 && errno == EINTR { continue }
            guard ready >= 0, item.revents & Int16(POLLNVAL | POLLERR) == 0 else { throw Failure.invalidInput }
            if ready == 0 || item.revents & Int16(POLLIN | POLLHUP) == 0 { continue }
            guard DispatchTime.now().uptimeNanoseconds < deadline else { throw Failure.invalidInput }
            let count = Darwin.read(fd, &buffer, min(buffer.count, limit - data.count + 1))
            if count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) { continue }
            guard DispatchTime.now().uptimeNanoseconds < deadline,
                  count >= 0, count <= limit - data.count else { throw Failure.invalidInput }
            if count == 0 { return data }
            data.append(contentsOf: buffer.prefix(count))
        }
        throw Failure.invalidInput
    }

    static func evaluate(_ input: Input, preparedContext: JSContext? = nil) throws -> String {
        guard input.script.utf8.count <= 65536, input.configuration.utf8.count <= 2097152,
              !input.script.utf8.contains(0), !input.configuration.utf8.contains(0),
              let arguments = String(data: try JSONSerialization.data(withJSONObject: [input.configuration, input.script]), encoding: .utf8),
              let context = preparedContext ?? JSContext() else { throw Failure.invalidInput }
        let program = #"""
        (() => {
          'use strict';
          const args = ARGUMENTS;
          const stringify = JSON.stringify, parse = JSON.parse;
          const plain = Object.prototype, array = Array.prototype;
          const getPrototype = Object.getPrototypeOf, descriptors = Object.getOwnPropertyDescriptors;
          const ownKeys = Reflect.ownKeys, isArray = Array.isArray, finite = Number.isFinite;
          const call = Function.prototype.call.bind(Function.prototype.call);
          const push = Array.prototype.push, join = Array.prototype.join, slice = String.prototype.slice;
          const setHas = Set.prototype.has, setAdd = Set.prototype.add, setDelete = Set.prototype.delete;
          const logs = [];
          const log = (...values) => {
            if (logs.length >= 64) return;
            const parts = [];
            for (const value of values) call(push, parts, typeof value === 'string' ? value : stringify(value));
            call(push, logs, call(slice, call(join, parts, ' '), 0, 1024));
          };
          Object.defineProperty(globalThis, 'console', {value: Object.freeze({log, info:log, warn:log, error:log, debug:log})});
          const main = Function('"use strict";\n' + args[1] + '\n;return typeof main === "function" ? main : null;')();
          if (typeof main !== 'function') throw Error('main required');
          const result = main(parse(args[0]));
          if (!result || typeof result !== 'object' || isArray(result)) throw Error('object required');
          let count = 0;
          const seen = new Set();
          const walk = (value, depth) => {
            if (++count > 50000 || depth > 40) throw Error('budget');
            if (value === null || typeof value === 'string' || typeof value === 'boolean') return stringify(value);
            if (typeof value === 'number' && finite(value)) return stringify(value);
            if (typeof value !== 'object' || call(setHas, seen, value)) throw Error('non JSON');
            const prototype = getPrototype(value);
            if (prototype !== plain && prototype !== array && prototype !== null) throw Error('prototype');
            call(setAdd, seen, value);
            const properties = descriptors(value), keys = ownKeys(properties), parts = [];
            const list = isArray(value);
            let index = 0;
            for (const key of keys) {
              if (list && key === 'length') continue;
              const property = properties[key];
              if (typeof key !== 'string' || key === '__proto__' || key === 'prototype' || key === 'constructor' || property.get || property.set || !property.enumerable) throw Error('property');
              if (list && key !== '' + index++) throw Error('array property');
              const serialized = walk(property.value, depth + 1);
              call(push, parts, list ? serialized : stringify(key) + ':' + serialized);
            }
            if (list && index !== properties.length.value) throw Error('sparse array');
            call(setDelete, seen, value);
            return (list ? '[' : '{') + call(join, parts, ',') + (list ? ']' : '}');
          };
          // Serialize inspected data ourselves: user code may replace global
          // intrinsics or add inherited toJSON, which JSON.stringify invokes.
          const configuration = walk(result, 0);
          return '{"configuration":' + stringify(configuration) + ',"logs":' + walk(logs, 0) + '}';
        })()
        """#.replacingOccurrences(of: "ARGUMENTS", with: arguments)
        let value = context.evaluateScript(program)
        guard context.exception == nil, let output = value?.toString(),
              output.utf8.count <= 5242880 else { throw Failure.rejected }
        return output
    }
}
