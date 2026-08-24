/**
 * p1-loader.js — Propeller P1 boot-protocol loader over Web Serial.
 *
 * Faithful port of p1_loader.py's Pmc8FirmwareLoader (MIT — see
 * THIRD_PARTY_NOTICES.md). The staging discipline is deliberate:
 *
 *   handshake()          writes nothing to the mount   — safe, read-only
 *   load(img, RUN_FROM_RAM)  volatile — a power cycle restores the firmware
 *   load(img, EEPROM_RUN)    permanent — overwrites mount firmware
 */

import {
  ACK_TIMEOUT_MS, CHECKSUM_TIMEOUT_MS,
  EEPROM_PROGRAM_TIMEOUT_MS, EEPROM_VERIFY_TIMEOUT_MS,
  EEPROM, EEPROM_RUN,
  assembleVersion, buildHandshake, buildPayload, estimateSeconds,
} from './p1-protocol.js';
import { sleep } from './p1-serial.js';

export class LoaderError extends Error {
  constructor(msg) { super(msg); this.name = 'LoaderError'; }
}

export class P1Loader {
  /** @param {SerialTransport} transport @param {(msg:string)=>void} progress */
  constructor(transport, progress = () => {}) {
    this.t = transport;
    this.progress = progress;
    this._rxbuf = new Uint8Array(0);
    this._rxnext = 0;
  }

  _report(m) { this.progress(m); }

  /**
   * Reset, handshake, read the chip version. Writes nothing to the mount —
   * the handshake bytes are consumed by the boot ROM, not stored.
   *
   * This is the milestone probe: success proves the reset wiring, the line
   * polarity, the LFSR, and that the timing window is reachable from a
   * browser. Returns the chip version (1 for a P1).
   */
  async handshake() {
    this._rxbuf = new Uint8Array(0);
    this._rxnext = 0;

    this._report('HANDSHAKE — pulsing reset');
    await this.t.reset();

    const { tx, expectedEcho } = buildHandshake();
    await this.t.tx(tx);

    this._report('RESPONSE — checking 250 echoed LFSR bits');
    for (let i = 0; i < 250; i++) {
      const bit = await this._receiveBit(100);
      if (bit < 0) {
        throw new LoaderError(
          `Handshake response timed out at bit ${i}` +
          (i === 0 ? ' (no reply at all — see docs/TROUBLESHOOTING.md)' : ''));
      }
      if (bit !== expectedEcho[i]) {
        throw new LoaderError(
          `Handshake mismatch at bit ${i}: chip said ${bit}, expected ${expectedEcho[i]}`);
      }
    }

    this._report('VERSION — reading 8 version bits');
    const bits = [];
    for (let i = 0; i < 8; i++) {
      const bit = await this._receiveBit(50);
      if (bit < 0) throw new LoaderError(`Version receive timed out at bit ${i}`);
      bits.push(bit);
    }
    const version = assembleVersion(bits);
    this._report(`Propeller version ${version}`);
    return version;
  }

  /**
   * Handshake then download `image` with the given load `kind`.
   * Returns { version, seconds }.
   */
  async load(image, kind) {
    // Encode BEFORE the handshake. The boot ROM applies an inter-byte timeout
    // during download; encoding 7000+ longs mid-stream would blow it.
    const payload = buildPayload(image, kind);

    const version = await this.handshake();

    const longs = image.length / 4;
    this._report(
      `PROGRAM ${image.length} bytes (${longs} longs) → ${payload.length} encoded bytes, ` +
      `~${estimateSeconds(payload.length).toFixed(1)}s on the wire`);

    const t0 = Date.now();
    await this.t.tx(payload);   // ONE write — see docs/PROTOCOL.md

    let sts = await this._waitForAck(Math.floor(CHECKSUM_TIMEOUT_MS / ACK_TIMEOUT_MS));
    if (sts < 0) {
      throw new LoaderError(
        'Boot ROM did not acknowledge the RAM load (timeout). If the image ' +
        'streamed but never ACKed, suspect a stall mid-write — the boot ROM ' +
        'aborts on inter-byte gaps and falls back to booting from EEPROM.');
    }
    if (sts === 0) throw new LoaderError('RAM load failed checksum (NAK)');
    this._report('RAM load acknowledged');

    if (kind === EEPROM || kind === EEPROM_RUN) {
      this._report('EEPROM_WRITE — burning, do not disconnect');
      sts = await this._waitForAck(Math.floor(EEPROM_PROGRAM_TIMEOUT_MS / ACK_TIMEOUT_MS));
      if (sts < 0) throw new LoaderError('EEPROM write ACK timed out');
      if (sts === 0) throw new LoaderError('EEPROM write failed (NAK)');

      this._report('EEPROM_VERIFY');
      sts = await this._waitForAck(Math.floor(EEPROM_VERIFY_TIMEOUT_MS / ACK_TIMEOUT_MS));
      if (sts < 0) throw new LoaderError('EEPROM verify ACK timed out');
      if (sts === 0) throw new LoaderError('EEPROM verify failed (NAK)');
    }

    const seconds = (Date.now() - t0) / 1000;
    this._report(`DONE in ${seconds.toFixed(1)}s`);
    return { version, seconds };
  }

  /** 1 = ACK, 0 = NAK/checksum fail, -1 = timeout. */
  async _waitForAck(retries) {
    for (let i = 0; i < retries; i++) {
      await sleep(20);
      await this.t.tx(new Uint8Array([0xf9]));
      const data = await this.t.rxTimeout(1, ACK_TIMEOUT_MS);
      if (data.length) return data[0] === 0xfe ? 1 : 0;
    }
    return -1;
  }

  /**
   * Valid response bytes are 0xFE (bit 0) and 0xFF (bit 1). Anything else is
   * skipped — which is also what makes this tolerant of leading junk from a
   * mount that was mid-sentence when we reset it. Returns -1 on timeout.
   */
  async _receiveBit(timeoutMs) {
    for (;;) {
      if (this._rxnext >= this._rxbuf.length) {
        this._rxbuf = await this.t.rxTimeout(256, timeoutMs);
        this._rxnext = 0;
        if (this._rxbuf.length === 0) return -1;
      }
      const result = this._rxbuf[this._rxnext] - 0xfe;
      this._rxnext++;
      if ((result & 0xfe) === 0) return result;
    }
  }
}

/**
 * Phase 0 — reset and listen. Writes nothing, not even handshake bytes.
 *
 * Normal firmware prints a long ASCII boot splash after reset (banner,
 * settings, "Mount Type: P9 = n", and the Wi-Fi module name), so SILENCE HERE
 * IS A SYMPTOM, not an expected outcome. Allow several seconds: the splash
 * itself waits ~2s for the Wi-Fi module, plus up to ~4s of AT polling.
 */
export async function resetAndListen(transport, seconds = 8, onChunk = () => {}) {
  await transport.reset();
  const deadline = Date.now() + seconds * 1000;
  const chunks = [];
  let total = 0;
  while (Date.now() < deadline) {
    const data = await transport.rxTimeout(4096, Math.max(50, deadline - Date.now()));
    if (data.length) { chunks.push(data); total += data.length; onChunk(data); }
  }
  const all = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { all.set(c, p); p += c.length; }
  return all;
}
