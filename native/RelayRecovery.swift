import Foundation

struct RelayRecoveryStatus: Encodable {
    let inventories: [BackupMetadataInventory]
    let metadataOnly = true
    let restoreEnabled = true
    let warnings = ["只读取备份清单元数据，不读取原文件内容，也不校验当前目标或执行恢复。",
        "Relay 与旧助手的记录分别保留；不可读或截断的列表不能视为没有待恢复记录。",
        "列表不授予恢复权限；须逐条预检、系统对话框确认并在写入前重新核对。"]
}

enum RelayRecovery {
    static func status(_ context: RelayStateContext) throws -> RelayRecoveryStatus {
        let paths = try RelayPreferenceStore(context)
        let home = URL(fileURLWithPath: context.home, isDirectory: true)
        return RelayRecoveryStatus(inventories: [
            NetworkConfiguration(home: home, supportRoot: paths.root).backupMetadata(),
            NetworkConfiguration(home: home, supportRoot: paths.legacyRoot).backupMetadata()
        ])
    }
}
