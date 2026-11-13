// Minimal protobuf fixtures built from the fixed core's public config.proto.
// CN is required by the fixed core's format verifier. Both artificial test
// categories contain only fixture.invalid / loopback, not geographic facts.
const varint = (value: number): Buffer => {
  const bytes: number[] = []
  do {
    let byte = value & 127
    value >>>= 7
    if (value) byte |= 128
    bytes.push(byte)
  } while (value)
  return Buffer.from(bytes)
}
const data = (field: number, value: Buffer | string): Buffer => {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value
  return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes])
}
export const geositeFixture = (): Buffer =>
  Buffer.concat(
    ['CN', 'RELAY'].map((code) =>
      data(
        1,
        Buffer.concat([
          data(1, code),
          data(2, Buffer.concat([Buffer.from([8, 3]), data(2, 'fixture.invalid')]))
        ])
      )
    )
  )
export const geoipFixture = (): Buffer =>
  Buffer.concat(
    ['CN', 'RELAY'].map((code) =>
      data(
        1,
        Buffer.concat([
          data(1, code),
          data(2, Buffer.concat([data(1, Buffer.from([127, 0, 0, 0])), Buffer.from([16, 8])]))
        ])
      )
    )
  )
