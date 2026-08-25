/**
 * mount-link.js — one command/reply interface over two very different wires.
 *
 * Everything above this layer only ever needs "send a command, get the reply",
 * so identify() and writeSettings() work unchanged over either transport:
 *
 *   SerialLink  USB via Web Serial. Desktop Chrome/Edge/Opera only.
 *   HttpLink    Wi-Fi via the ESP32's HTTP bridge. Works anywhere fetch()
 *               does — including iPhone, which has no Web Serial at all.
 *
 * What Wi-Fi CANNOT do, and why:
 *
 *   AT+GMR   reaching the module means ESPw42!, which bridges USB to the
 *            module. Over Wi-Fi you are already talking *through* the module,
 *            so entering passthrough would sever the link you are using.
 *   P1 load  needs a DTR reset and a raw byte stream into the boot ROM.
 *
 * Both are gated on `canPassthrough` rather than being attempted and failing.
 */

import { ask } from './pmc8-identify.js';

/** USB. Wraps the byte-stream transport and speaks commands. */
export class SerialLink {
  constructor(transport) {
    this.transport = transport;
    this.kind = 'serial';
    this.label = 'USB serial';
    this.canPassthrough = true;
  }

  async send(cmd, opts = {}) {
    return ask(this.transport, cmd, opts);
  }

  async close() {
    await this.transport.close();
  }
}

/**
 * Wi-Fi. POSTs the raw command to the ESP32's /cmd endpoint and returns the
 * response body, matching HttpMountClient.SendCommandAsync in the PWA.
 */
/**
 * Wi-Fi from a browser needs the mount to run the ES **HTTP bridge**, which
 * answers `POST /cmd` on port 80. That is the whole story, and the module type
 * is only a proxy for it:
 *
 *   RN-131                      never. It speaks raw TCP on 54372 only.
 *   ESP8266 / ESP32, legacy     no. Same raw-TCP-only story.
 *   ESP8266 / ESP32, new bridge yes. This is the case Wi-Fi was built for.
 *
 * A browser cannot open a raw TCP socket at all — fetch() speaks HTTP and
 * nothing else — so a mount without the bridge is unreachable from a web page
 * no matter what the page does. The PWA reaches those mounts only because
 * mount-proxy.js does the TCP for it from Node.
 */
const NO_BRIDGE = (host, why) =>
  `No HTTP bridge at ${host} (${why}). Wi-Fi from a browser needs the ES HTTP ` +
  'bridge on port 80. An RN-131, or an ESP8266/ESP32 running older firmware, ' +
  'speaks raw TCP on 54372 instead — which a browser cannot open at all. Use ' +
  'the USB cable for those. Also check the address, that this device is on the ' +
  'same network, and that this page is served over http:// rather than https://.';

/**
 * Normalise a typed-in mount address. Exported so callers can compare what the
 * user has typed against an existing link's host without building one.
 */
export function normalizeHost(host) {
  return String(host ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

export class HttpLink {
  /**
   * @param {string} host  "192.168.1.50" or "192.168.1.50:80"
   */
  constructor(host) {
    const clean = normalizeHost(host);
    if (!clean) throw new Error('Enter the mount\'s IP address.');
    this.host = clean;
    this.base = `http://${clean}`;
    this.kind = 'http';
    this.label = `Wi-Fi ${clean}`;
    this.canPassthrough = false;
    this._lastDone = 0;
  }

  /**
   * The AT module needs a quiet gap to leave WAITING_FOR_SEND_OK before the
   * next command lands, or replies collide. 200 ms, same as the PWA.
   */
  async _quiet() {
    const since = Date.now() - this._lastDone;
    if (since < 200) await new Promise((r) => setTimeout(r, 200 - since));
  }

  async send(cmd, { timeoutMs = 3000 } = {}) {
    await this._quiet();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.base}/cmd`, {
        method: 'POST',
        body: cmd,
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`Mount returned HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(NO_BRIDGE(this.host, 'timed out'));
      // fetch() reports CORS, mixed-content and connection-refused failures
      // alike as an opaque TypeError, so the message has to cover the field.
      if (e instanceof TypeError) throw new Error(NO_BRIDGE(this.host, 'no answer'));
      throw e;
    } finally {
      clearTimeout(timer);
      this._lastDone = Date.now();
    }
  }

  async close() { /* stateless */ }
}

/** True when this browser can do USB at all. */
export function serialAvailable() {
  return typeof navigator !== 'undefined' &&
         'serial' in navigator &&
         typeof window !== 'undefined' &&
         window.isSecureContext;
}
