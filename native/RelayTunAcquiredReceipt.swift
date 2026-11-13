import Foundation
import Darwin

/// Immutable metadata accompanying an authenticated acquired-FD reply. A valid
/// receipt neither authenticates its sender nor proves FD/device ownership,
/// authorization freshness, forwarding readiness or completed restoration.
/// The enclosing wire decoder must reject duplicate JSON keys before Codable.
struct RelayTunAcquiredReceipt: Codable, Equatable {
    enum Failure: Error { case invalid }
    let version: UInt32
    let installationRevision: String
    let clientUID: UInt32
    let evidenceSHA256: String
    let runtimeConfigurationSHA256: String
    let planID: String
    let sessionID: String
    let deviceID: String
    let interfaceName: String
    let interfaceIndex: UInt32
    let controlID: UInt32
    let controlUnit: UInt32
    // Decimal strings preserve Darwin's complete unsigned socket observations,
    // including zero. These values supplement the exact held FD; zero inode is
    // permitted and neither numeric observation establishes exclusive identity.
    let socketDevice: String
    let socketInode: String
    private let deviceNumber: UInt64
    private let inodeNumber: UInt64
    var socketDeviceValue: UInt64 { deviceNumber }
    var socketInodeValue: UInt64 { inodeNumber }

    init(installationRevision: String, clientUID: UInt32, evidenceSHA256: String,
         runtimeConfigurationSHA256: String, planID: String, sessionID: String, deviceID: String,
         interfaceName: String, interfaceIndex: UInt32, controlID: UInt32, controlUnit: UInt32,
         socketDevice: String, socketInode: String) throws {
        version = 1; self.installationRevision = installationRevision; self.clientUID = clientUID
        self.evidenceSHA256 = evidenceSHA256; self.runtimeConfigurationSHA256 = runtimeConfigurationSHA256
        self.planID = planID; self.sessionID = sessionID; self.deviceID = deviceID
        self.interfaceName = interfaceName; self.interfaceIndex = interfaceIndex
        self.controlID = controlID; self.controlUnit = controlUnit
        self.socketDevice = socketDevice; self.socketInode = socketInode
        deviceNumber = try Self.decimal(socketDevice); inodeNumber = try Self.decimal(socketInode)
        try validate()
    }
    private static func digest(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    private static func uuid(_ value: String) -> Bool {
        value.utf8.count == 36 && UUID(uuidString: value)?.uuidString.lowercased() == value
    }
    private static func decimal(_ value: String) throws -> UInt64 {
        guard !value.isEmpty, value.utf8.count <= 20,
              value.utf8.allSatisfy({ (48...57).contains($0) }),
              let number = UInt64(value), String(number) == value else { throw Failure.invalid }
        return number
    }
    func validate() throws {
        guard version == 1, Self.digest(installationRevision), clientUID > 0,
              Self.digest(evidenceSHA256), Self.digest(runtimeConfigurationSHA256),
              Self.uuid(planID), Self.uuid(sessionID), Self.uuid(deviceID),
              interfaceName.utf8.count < Int(IFNAMSIZ), interfaceName.hasPrefix("utun"),
              let number = UInt32(interfaceName.dropFirst(4)), number < UInt32.max,
              String(number) == interfaceName.dropFirst(4), interfaceIndex > 0, controlID > 0,
              controlUnit == number + 1,
              try Self.decimal(socketDevice) == deviceNumber,
              try Self.decimal(socketInode) == inodeNumber else { throw Failure.invalid }
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case version, installationRevision, clientUID, evidenceSHA256, runtimeConfigurationSHA256
        case planID, sessionID, deviceID, interfaceName, interfaceIndex, controlID, controlUnit, socketDevice, socketInode
    }
    private struct AnyKey: CodingKey {
        let stringValue: String
        let intValue: Int? = nil
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }
    init(from decoder: Decoder) throws {
        let all = try decoder.container(keyedBy: AnyKey.self)
        guard Set(all.allKeys.map(\.stringValue)) == Set(CodingKeys.allCases.map(\.rawValue)) else { throw Failure.invalid }
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        guard try fields.decode(UInt32.self, forKey: .version) == 1 else { throw Failure.invalid }
        try self.init(installationRevision: fields.decode(String.self, forKey: .installationRevision),
                      clientUID: fields.decode(UInt32.self, forKey: .clientUID),
                      evidenceSHA256: fields.decode(String.self, forKey: .evidenceSHA256),
                      runtimeConfigurationSHA256: fields.decode(String.self, forKey: .runtimeConfigurationSHA256),
                      planID: fields.decode(String.self, forKey: .planID), sessionID: fields.decode(String.self, forKey: .sessionID),
                      deviceID: fields.decode(String.self, forKey: .deviceID), interfaceName: fields.decode(String.self, forKey: .interfaceName),
                      interfaceIndex: fields.decode(UInt32.self, forKey: .interfaceIndex),
                      controlID: fields.decode(UInt32.self, forKey: .controlID), controlUnit: fields.decode(UInt32.self, forKey: .controlUnit),
                      socketDevice: fields.decode(String.self, forKey: .socketDevice), socketInode: fields.decode(String.self, forKey: .socketInode))
    }
    func encode(to encoder: Encoder) throws {
        try validate()
        var fields = encoder.container(keyedBy: CodingKeys.self)
        try fields.encode(version, forKey: .version); try fields.encode(installationRevision, forKey: .installationRevision)
        try fields.encode(clientUID, forKey: .clientUID); try fields.encode(evidenceSHA256, forKey: .evidenceSHA256)
        try fields.encode(runtimeConfigurationSHA256, forKey: .runtimeConfigurationSHA256)
        try fields.encode(planID, forKey: .planID); try fields.encode(sessionID, forKey: .sessionID); try fields.encode(deviceID, forKey: .deviceID)
        try fields.encode(interfaceName, forKey: .interfaceName); try fields.encode(interfaceIndex, forKey: .interfaceIndex)
        try fields.encode(controlID, forKey: .controlID); try fields.encode(controlUnit, forKey: .controlUnit)
        try fields.encode(socketDevice, forKey: .socketDevice); try fields.encode(socketInode, forKey: .socketInode)
    }
}
