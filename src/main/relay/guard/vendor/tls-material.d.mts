import type { Buffer } from 'node:buffer'
export function mintScopedTLS(): Promise<{ key: Buffer; cert: string; ca: string }>
