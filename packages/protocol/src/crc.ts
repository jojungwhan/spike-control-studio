/**
 * CRC-8, polynomial 0x07, init 0x00, no reflection, no final XOR.
 *
 * Chosen because the hub agent reimplements this in MicroPython without a
 * lookup table — the bitwise form below is a direct transliteration target.
 */
export function crc8(bytes: Uint8Array): number {
  let crc = 0x00;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}
