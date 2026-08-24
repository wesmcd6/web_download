/**
 * p1-protocol.js — Parallax Propeller 1 (P8X32A) boot protocol, pure functions.
 *
 * No I/O, no Web Serial, no DOM. Everything here is deterministic and testable
 * without hardware — see test/vectors.js for golden vectors generated from the
 * hardware-proven Python implementation.
 *
 * Ported from p1_loader.py (MIT), which is itself derived from p1load's
 * ploader.c by dbetz (MIT, (c) 2015), adapted from Chip Gracey's PNut IDE.
 * See THIRD_PARTY_NOTICES.md.
 */

// ---- load types ------------------------------------------------------------
export const SHUTDOWN = 0;      // load to RAM, stop (Propeller sleeps)
export const RUN_FROM_RAM = 1;  // load to RAM, run immediately  <- reversible
export const EEPROM = 2;        // write EEPROM, stop
export const EEPROM_RUN = 3;    // write EEPROM, then run        <- permanent

// ---- wire constants — from ploader.h / PNut ---------------------------------
export const BAUD = 115200;
export const RESET_PULSE_MS = 25;    // hold DTR asserted (reset held)
export const POST_RESET_MS = 90;     // boot ROM startup wait
export const ACK_TIMEOUT_MS = 25;    // per-attempt ACK timeout
export const CHECKSUM_TIMEOUT_MS = 10000;
export const EEPROM_PROGRAM_TIMEOUT_MS = 5000;
export const EEPROM_VERIFY_TIMEOUT_MS = 2000;
export const HUB_MEMORY_SIZE = 32768;
export const LFSR_SEED = 0x50;       // 'P'

/**
 * The boot ROM's LFSR. Taps 7, 5, 4, 1 — maximal-length, period 255.
 * Stateful by design: the handshake sends 250 iterations, then the *echo*
 * must match the NEXT 250 iterations of the same running sequence.
 */
export class Lfsr {
  constructor(seed = LFSR_SEED) {
    this.state = seed & 0xff;
  }
  /** Returns the next output bit (0 or 1) and advances the register. */
  next() {
    const s = this.state;
    const result = s & 1;
    const tap = ((s >> 7) ^ (s >> 5) ^ (s >> 4) ^ (s >> 1)) & 1;
    this.state = ((s << 1) & 0xfe) | tap;
    return result;
  }
}

/**
 * Encode a 32-bit value into the boot ROM's 11-byte download form:
 * 3 bits per byte, low bits first, with 0x60 set on the final byte.
 */
export function encodeLong(value) {
  let x = value >>> 0;
  const out = new Uint8Array(11);
  for (let i = 0; i < 11; i++) {
    const flag = i === 10 ? 0x60 : 0;
    out[i] = (0x92 | flag | (x & 1) | ((x & 2) << 2) | ((x & 4) << 4)) & 0xff;
    x = x >>> 3;
  }
  return out;
}

/**
 * Build the 509-byte handshake transmission in one buffer:
 *   1   calibration byte (0xF9)
 *   250 LFSR bits as 0xFE|bit
 *   258 timing bytes (0xF9) to clock out 250 echo bits + 8 version bits
 *
 * Returns { tx, expectedEcho } where expectedEcho is the 250 bits the chip
 * must echo back — the NEXT 250 iterations of the same LFSR.
 */
export function buildHandshake() {
  const tx = new Uint8Array(1 + 250 + 258);
  const lfsr = new Lfsr(LFSR_SEED);
  let p = 0;
  tx[p++] = 0xf9;
  for (let i = 0; i < 250; i++) tx[p++] = lfsr.next() | 0xfe;
  for (let i = 0; i < 258; i++) tx[p++] = 0xf9;

  const expectedEcho = new Uint8Array(250);
  for (let i = 0; i < 250; i++) expectedEcho[i] = lfsr.next();

  return { tx, expectedEcho };
}

/**
 * Pre-encode the entire download so it can go out as ONE write().
 *
 * Layout: encoded command long, encoded long-count, then the image at 11
 * encoded bytes per 32-bit little-endian long.
 *
 * This MUST be built before the handshake starts. The boot ROM applies an
 * inter-byte timeout during download; any stall — including the time spent
 * encoding — risks it aborting and booting from EEPROM instead.
 */
export function buildPayload(image, kind) {
  if (!image || image.length === 0) throw new Error('Image is empty');
  if (image.length & 3) {
    throw new Error(`Image size must be a multiple of 4 (got ${image.length})`);
  }
  if (image.length > HUB_MEMORY_SIZE) {
    throw new Error(
      `Image too big for hub memory: ${image.length} > ${HUB_MEMORY_SIZE}`);
  }

  const longs = image.length / 4;
  const out = new Uint8Array((2 + longs) * 11);
  let p = 0;
  out.set(encodeLong(kind), p); p += 11;
  out.set(encodeLong(longs), p); p += 11;
  for (let i = 0; i < image.length; i += 4) {
    const word = (image[i] |
                  (image[i + 1] << 8) |
                  (image[i + 2] << 16) |
                  (image[i + 3] << 24)) >>> 0;
    out.set(encodeLong(word), p); p += 11;
  }
  return out;
}

/** Assemble the 8 version bits (LSB first) into the chip version. P1 == 1. */
export function assembleVersion(bits) {
  let version = 0;
  for (let i = 0; i < 8; i++) {
    version = ((version >> 1) & 0x7f) | (bits[i] << 7);
  }
  return version;
}

/** Wall-clock estimate for streaming `nbytes` at 115200 8N1 (10 bits/byte). */
export function estimateSeconds(nbytes) {
  return (nbytes * 10) / BAUD;
}
