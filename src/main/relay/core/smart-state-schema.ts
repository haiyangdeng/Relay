import { createHash } from 'crypto'

export const smartStateSchema = Object.freeze({
  version: 1 as const,
  profile: 'smart-4624551',
  csvHeaderBytes: 555,
  csvHeaderSHA256: '14535c00a00d6f4e380acfc91b2da9f312d9fd78c9322eae1aa14f8587067b84',
  fileByteLimit: 128 * 1024 * 1024,
  totalByteLimit: 256 * 1024 * 1024
})
// Fixed Smart462 collector.go schema. This is the sole Node header literal;
// models, configuration revisions and sessions do not change these columns.
const csvHeader =
  'success,failure,connect_time,latency,upload_mb,history_upload_mb,maxuploadrate_kb,history_maxuploadrate_kb,download_mb,history_download_mb,maxdownloadrate_kb,history_maxdownloadrate_kb,duration_minutes,history_duration_minutes,last_used_seconds,is_udp,is_tcp,loss_rate,cumul_loss_rate,asn_feature,country_feature,address_feature,port_feature,traffic_ratio,traffic_density,connection_type_feature,asn_hash,host_hash,ip_hash,geoip_hash,exit_region,exit_asn_hash,group_name,node_name,asn_raw,host_raw,ip_raw,port_raw,geoip_raw,weight,weight_source,timestamp\n'

export type SmartStatePath = 'cache.db' | 'smart_weight_data.csv'
export interface SmartStateFile {
  readonly path: SmartStatePath
  readonly sha256: string
  readonly size: number
}
export interface SmartStateSeedV1 {
  readonly version: 1
  readonly key: string
  readonly previousRevision: string | null
  readonly files: readonly SmartStateFile[]
}
export interface SmartStateFileData {
  readonly path: SmartStatePath
  readonly bytes: Buffer
}
export const smartStateDigest = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

export function smartStateCSVHeader(): Buffer {
  const bytes = Buffer.from(csvHeader, 'ascii')
  if (
    bytes.length !== smartStateSchema.csvHeaderBytes ||
    smartStateDigest(bytes) !== smartStateSchema.csvHeaderSHA256
  )
    throw new Error('固定Smart CSV首行不一致。')
  return bytes
}
export function smartStateKey(profileUUID: string): string {
  if (
    typeof profileUUID !== 'string' ||
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(profileUUID)
  )
    throw new Error('Smart状态来源ID无效。')
  return smartStateDigest(
    Buffer.from(
      JSON.stringify([
        'relay-smart-state-v1',
        profileUUID,
        smartStateSchema.profile,
        smartStateSchema.csvHeaderSHA256
      ])
    )
  )
}
