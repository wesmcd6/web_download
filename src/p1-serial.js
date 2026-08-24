/**
 * p1-serial.js — Web Serial transport for the Propeller P1 loader.
 *
 * Mirrors the transport contract of p1_loader.py: reset(), tx(), rxTimeout(),
 * close(). The Python version uses raw Win32 calls because pyserial's
 * overlapped WriteFile leaves inter-byte gaps mid-image that trip the boot
 * ROM's download timeout. Chrome's serial service does its own buffering, so
 * we hand it the whole image in ONE write() and let it stream — see
 * docs/PROTOCOL.md, "The contiguous-write risk".
 */

import { BAUD, RESET_PULSE_MS, POST_RESET_MS } from './p1-protocol.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

/** Why Web Serial is unavailable, in words a user can act on. */
export function unsupportedReason() {
  if (typeof window === 'undefined') return 'Not running in a browser.';
  if (!window.isSecureContext) {
    return 'This page must be served over HTTPS or from http://localhost. ' +
           'Opening the file directly (file://) will not work.';
  }
  if (!('serial' in navigator)) {
    return 'This browser has no Web Serial API. Use desktop Chrome, Edge or ' +
           'Opera — Firefox, Safari, iOS and Android Chrome are not supported.';
  }
  return null;
}

export class SerialTransport {
  /**
   * @param {SerialPort} port   an already-requested Web Serial port
   * @param {object} opts
   *   baudRate   default 115200
   *   invertDtr  drive reset with DTR de-asserted instead of asserted
   *   useRts     pulse RTS instead of DTR
   *   resetMs / settleMs   override the 25 / 90 ms defaults
   *   log        (msg) => void
   */
  constructor(port, opts = {}) {
    this.port = port;
    this.baudRate = opts.baudRate ?? BAUD;
    this.invertDtr = !!opts.invertDtr;
    this.useRts = !!opts.useRts;
    this.resetMs = opts.resetMs ?? RESET_PULSE_MS;
    this.settleMs = opts.settleMs ?? POST_RESET_MS;
    this.log = opts.log ?? (() => {});

    this._reader = null;
    this._writer = null;
    this._buf = [];        // queue of Uint8Array chunks
    this._bufLen = 0;
    this._wake = null;     // resolver for a pending read
    this._pump = null;
    this._closed = false;
  }

  async open() {
    await this.port.open({
      baudRate: this.baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      bufferSize: 65536,
    });

    // SerialOptions has no DTR field and the state after open() is not
    // specified — Windows drivers commonly assert DTR, which would reset the
    // Propeller before we are ready. De-assert both lines explicitly, then
    // let the mount finish whatever boot that already triggered.
    await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });

    this._writer = this.port.writable.getWriter();
    this._startPump();
    await sleep(200);
    this.flush();
  }

  _startPump() {
    this._reader = this.port.readable.getReader();
    this._pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await this._reader.read();
          if (done) break;
          if (value && value.length) {
            this._buf.push(value);
            this._bufLen += value.length;
            if (this._wake) { const w = this._wake; this._wake = null; w(); }
          }
        }
      } catch (e) {
        if (!this._closed) this.log(`read error: ${e.message}`);
      }
    })();
  }

  /** Discard buffered input. The equivalent of Win32 PurgeComm. */
  flush() {
    this._buf = [];
    this._bufLen = 0;
  }

  /**
   * Pulse the reset line. Asserting DTR (`dataTerminalReady: true`) is what
   * p1_loader.py does via EscapeCommFunction(SETDTR) — Chrome maps
   * setSignals() onto the same OS call, so this is the known-good default.
   */
  async reset() {
    const line = this.useRts ? 'requestToSend' : 'dataTerminalReady';
    const asserted = !this.invertDtr;
    await this.port.setSignals({ [line]: asserted });
    await sleep(this.resetMs);
    await this.port.setSignals({ [line]: !asserted });
    await sleep(this.settleMs);
    this.flush();
  }

  /** Write bytes. One call per logical message — minimise Web Serial calls. */
  async tx(data) {
    await this._writer.write(data);
    return data.length;
  }

  /**
   * Read up to `n` bytes, returning as soon as any are available.
   * Returns an empty Uint8Array on timeout — same contract as
   * p1_loader.py's rx_timeout().
   */
  async rxTimeout(n, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (this._bufLen === 0) {
      const left = deadline - Date.now();
      if (left <= 0) return new Uint8Array(0);
      await new Promise((resolve) => {
        this._wake = resolve;
        setTimeout(() => {
          if (this._wake === resolve) { this._wake = null; resolve(); }
        }, left);
      });
    }
    return this._take(Math.min(n, this._bufLen));
  }

  _take(n) {
    const out = new Uint8Array(n);
    let p = 0;
    while (p < n) {
      const head = this._buf[0];
      const need = n - p;
      if (head.length <= need) {
        out.set(head, p);
        p += head.length;
        this._buf.shift();
      } else {
        out.set(head.subarray(0, need), p);
        this._buf[0] = head.subarray(need);
        p += need;
      }
    }
    this._bufLen -= n;
    return out;
  }

  async close() {
    this._closed = true;
    try { await this._reader?.cancel(); } catch { /* already gone */ }
    try { this._reader?.releaseLock(); } catch { /* already released */ }
    try { await this._pump; } catch { /* pump already unwound */ }
    try { await this._writer?.close(); } catch { /* already closed */ }
    try { this._writer?.releaseLock(); } catch { /* already released */ }
    try { await this.port.close(); } catch { /* already closed */ }
  }
}

/** Prompt the user to pick a port. Must be called from a user gesture. */
export async function requestPort() {
  return navigator.serial.requestPort({});
}
