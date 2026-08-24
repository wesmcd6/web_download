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
import { ask, parseESGv } from './pmc8-identify.js';

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
  /**
   * Handshake, retrying on failure.
   *
   * A single attempt is fragile in a way that has nothing to do with the
   * protocol: a transient serial read error (e.g. "Buffer overrun") drops the
   * reader mid-sequence, and the handshake then reports a timeout at whatever
   * bit it had reached. Each attempt re-pulses reset, so retrying is clean.
   */
  async handshake({ attempts = 3 } = {}) {
    let lastErr;
    for (let a = 1; a <= attempts; a++) {
      const errsBefore = this.t.readErrors ?? 0;
      try {
        return await this._handshakeOnce();
      } catch (e) {
        lastErr = e;
        const hadReadError = (this.t.readErrors ?? 0) > errsBefore;
        if (a < attempts) {
          this._report(
            `attempt ${a} failed (${e.message})` +
            `${hadReadError ? ' after a serial read error' : ''} — retrying`);
          await sleep(300);
        }
      }
    }
    throw lastErr;
  }

  async _handshakeOnce() {
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
 * Phase 0 — reset, wait out the boot, then ask the firmware its version.
 *
 * Normal firmware prints a long ASCII boot splash after reset (banner,
 * settings, "Mount Type: P9 = n", and the Wi-Fi module name), so SILENCE HERE
 * IS A SYMPTOM, not an expected outcome.
 *
 * A full reset can take 15-20 seconds: the splash embeds a 2s Wi-Fi settle
 * plus AT polling, and the mount keeps printing a "\ / | -" spinner while it
 * initialises the ESP module. So we wait for the line to fall quiet rather
 * than for a fixed delay, then send ESGv!. Getting a parsed version back is a
 * positive confirmation the round trip works — much stronger evidence than
 * "some bytes came out".
 *
 * Still writes nothing that changes the mount: ESGv! is a pure read.
 */
export async function resetAndListen(transport, opts = {}) {
  const {
    maxSeconds = 25,
    quietMs = 2500,
    minSeconds = 5,
    askVersion = true,
    versionWindowMs = 30000,
    onChunk = () => {},
    progress = () => {},
  } = opts;

  progress('Pulsing reset…');
  await transport.reset();

  const start = Date.now();
  const deadline = start + maxSeconds * 1000;
  const chunks = [];
  let total = 0;
  let lastData = Date.now();
  let announced = false;

  while (Date.now() < deadline) {
    const remain = deadline - Date.now();
    const data = await transport.rxTimeout(4096, Math.min(300, Math.max(50, remain)));
    if (data.length) {
      chunks.push(data);
      total += data.length;
      lastData = Date.now();
      onChunk(data);
      if (!announced) {
        announced = true;
        progress('Boot output started — waiting for it to finish…');
      }
    } else if (total > 0 &&
               Date.now() - lastData > quietMs &&
               Date.now() - start > minSeconds * 1000) {
      progress(`Line quiet after ${((Date.now() - start) / 1000).toFixed(1)}s.`);
      break;
    }
  }

  const result = {
    splash: null, firmware: null, p9: null,
    versionError: null, versionConfirmed: false, versionAttempts: 0,
  };

  /**
   * Poll rather than guess when boot has finished.
   *
   * The spinner pauses for longer than any sane quiet threshold, so
   * "the line went quiet" is not a reliable end-of-boot signal — it fires
   * while the firmware is still inside SplashScreen, before the command
   * interpreter runs, and ESGv! is simply ignored. Retrying until it answers
   * is self-correcting and needs no estimate of how long boot takes.
   */
  if (askVersion) {
    const vDeadline = Date.now() + versionWindowMs;
    while (Date.now() < vDeadline) {
      result.versionAttempts++;
      const left = Math.ceil((vDeadline - Date.now()) / 1000);
      progress(`ESGv! attempt ${result.versionAttempts} (${left}s left)…`);
      let raw = '';
      try {
        raw = await ask(transport, 'ESGv!', { expect: 'ESGv', timeoutMs: 2000 });
      } catch (e) {
        result.versionError = e.message;
      }
      // Anything the mount said while we were asking is still boot output.
      if (raw) {
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 0xff;
        chunks.push(bytes);
        total += bytes.length;
      }
      if (raw.includes('ESGv')) {
        try {
          result.firmware = parseESGv(raw);
          result.versionConfirmed = true;
          break;
        } catch (e) {
          result.versionError = e.message;
        }
      } else if (raw) {
        result.versionError = 'no ESGv reply (mount still booting?)';
      }
      await sleep(700);
    }
  }

  const splash = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { splash.set(c, p); p += c.length; }
  result.splash = splash;

  // Scrape the banner and P9 out of whatever text we ended up with. Useful
  // even when ESGv! never answers.
  const text = new TextDecoder('latin1').decode(splash);
  if (!result.versionConfirmed) {
    const banner = text.match(/ES20A02\.[0-9.]+\.bt[^\r\n=]*/);
    if (banner) result.firmware = banner[0].trim();
  }
  const p9 = text.match(/Mount Type:\s*P9\s*=\s*(\d+)/);
  if (p9) result.p9 = Number(p9[1]);
  const wifi = text.match(/ESP-32 ver: *([^\r\n]*)|ESP-8266[^\r\n]*|RN-131/);
  if (wifi) result.wifiLine = wifi[0].trim();

  return result;
}
