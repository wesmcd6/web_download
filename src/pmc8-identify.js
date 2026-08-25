/**
 * pmc8-identify.js — read-only "identify my mount" over Web Serial.
 *
 * Sends exactly two commands, both proven side-effect-free against the
 * firmware source (ES20A02.2.0.1.bt, Release 2026.08.10):
 *
 *   ESGv!  -> firmware banner
 *   ESGi!  -> 36-byte config block: mount model (P9) and Wi-Fi module type
 *
 * NOTHING ELSE IS SENT. See docs/FIRMWARE-NOTES.md for the do-not-send list —
 * several commands that look like getters are not. `ESGe!` in particular
 * writes EEPROM.
 */

import { sleep } from './p1-serial.js';

const DEC = new TextDecoder('latin1');
const ENC = new TextEncoder();

/**
 * The firmware validates PARAM_0 against exactly this set and defaults to
 * 115200. In practice mounts are always at 115200, so the tools open at that
 * rate and do not sweep; this is kept for reference and for any future
 * recovery path if a mount is ever found at a non-default rate.
 */
export const BAUD_RATES = [115200, 9600, 14400, 19200, 38400, 57600];

/**
 * P9 -> mount model.
 *
 * IMPORTANT: P9 is only a stored default, and it is partly deprecated. It
 * historically encoded BOTH the mount type and the Wi-Fi module type, and that
 * mapping was never completed. The firmware now auto-detects the Wi-Fi module
 * at every boot, but still falls back to P9 for the mount type. So:
 *
 *   - Wi-Fi module: use the `w` field. Auto-detected, reliable.
 *   - Mount model:  P9 is the only source, but it is a setting someone
 *                   configured, not a detection. It can be wrong.
 *
 * Never infer the Wi-Fi module from P9.
 *
 * The firmware prints P9 as DECIMAL in the ESGi reply but parses it as HEX on
 * input, so the printed "15" is P9 value 15 (0xF). Read the field with
 * parseInt(.., 10) — base 16 would silently mangle it.
 *
 * Settled by reading the full LOOKDOWN chain in the firmware, not one block:
 * later blocks reassign what earlier ones set.
 */
const MODELS = {
  0:  { name: 'iEXOS-100', note: 'original board' },
  1:  { name: 'iEXOS-100' },
  2:  { name: 'iEXOS-200' },
  3:  { name: 'iEXOS-300' },
  4:  { name: 'G-11' }, 5: { name: 'G-11' }, 6: { name: 'G-11' }, 7: { name: 'G-11' },
  8:  { name: 'EXOS-2' }, 9: { name: 'EXOS-2' },
  10: { name: 'EXOS-2' }, 11: { name: 'EXOS-2' },
  12: { name: 'iEXOS-100', note: '"Scotty" variant' },
  13: { name: 'Titan' },
  14: { name: 'MSR EQ' },
  15: { name: 'ASKO SX260S' },
};

const WIFI = {
  0: {
    name: 'RN-131',
    caveat: 'The firmware reports 0 when the module did not answer AT at all — ' +
            'so an absent, dead or unpowered module also reads as RN-131.',
  },
  1: {
    name: 'ESP8266',
    caveat: 'Strictly this means "answered AT, but AT+GMR did not contain ES". ' +
            'An ESP32 running stock Espressif AT firmware would also read as 1.',
  },
  2: { name: 'ESP32' },
};

/**
 * Parse the fixed 36-byte ESGi reply by cumulative field width.
 * Layout: ESGi | baud(6) | tcp(1) | trackNoComms(1) | raBoot(1) | hemi(1) |
 *         srfRA(3) | srfDec(3) | P9(2) | slewMa(4) | trackMa(4) |
 *         wifiChan(2) | st4Disable(1) | oldSt4(1) | wifiType(1) | !
 */
export function parseESGi(reply) {
  const s = typeof reply === 'string' ? reply : DEC.decode(reply);
  const body = s.slice(s.indexOf('ESGi'));
  if (!body.startsWith('ESGi')) throw new Error('Not an ESGi reply');
  if (body.length < 36) {
    throw new Error(`ESGi reply too short: ${body.length} bytes, expected 36`);
  }

  let p = 4;
  const take = (n) => { const v = body.slice(p, p + n); p += n; return v; };
  const num = (n) => parseInt(take(n), 10);

  const out = {
    baud: num(6),
    tcpip: num(1) === 0,
    trackOnCommsLoss: num(1) === 1,
    raRunOnBoot: num(1) === 1,
    hemisphere: num(1) === 1 ? 'North' : 'South',
    guideRateRA: num(3),
    guideRateDec: num(3),
    p9: num(2),
    slewCurrentMa: num(4),
    trackCurrentMa: num(4),
    wifiChannel: num(2),
    st4Disabled: num(1) === 1,
    st4Analog: num(1) === 1,
    wifiType: num(1),
    raw: body.slice(0, 36),
  };

  const model = MODELS[out.p9];
  out.model = model ? model.name : `Unknown (P9=${out.p9})`;
  out.modelNote = model?.note ?? null;
  // P9 is never range-corrected at boot: all 16 values are legal, so a P9
  // corrupted to 0 presents as a genuine iEXOS-100 and cannot be told apart.
  out.modelAmbiguous = out.p9 === 0;

  const wifi = WIFI[out.wifiType];
  out.wifi = wifi ? wifi.name : `Unknown (${out.wifiType})`;
  out.wifiCaveat = wifi?.caveat ?? null;

  return out;
}

/**
 * The full settings block, in the same order and with the same labels the PMC8
 * Dashboard uses, so the two tools can be read side by side.
 */
export function settingsRows(cfg) {
  const model = MODELS[cfg.p9];
  return [
    { label: 'Baud Rate', value: String(cfg.baud) },
    { label: 'IP Protocol', value: cfg.tcpip ? 'TCP' : 'UDP' },
    { label: 'Continuous Track', value: cfg.trackOnCommsLoss ? 'On' : 'Off' },
    { label: 'Run on Boot', value: cfg.raRunOnBoot ? 'YES' : 'NO' },
    { label: 'Hemisphere', value: cfg.hemisphere },
    { label: 'Sidereal Rate Fraction RA %', value: String(cfg.guideRateRA) },
    { label: 'Sidereal Rate Fraction DEC %', value: String(cfg.guideRateDec) },
    {
      label: 'Mount Type',
      value: cfg.model,
      note: [`P9 = ${cfg.p9}`, model?.note].filter(Boolean).join(' · '),
    },
    { label: 'Motor Current Slew, ma', value: String(cfg.slewCurrentMa) },
    { label: 'Motor Current Track, ma', value: String(cfg.trackCurrentMa) },
    { label: 'WiFi Channel', value: String(cfg.wifiChannel) },
    { label: 'ST4 Status', value: cfg.st4Disabled ? 'Disabled' : 'Enabled' },
    { label: 'ST4 Type', value: cfg.st4Analog ? 'Analog' : 'Digital' },
    {
      label: 'WiFi Type',
      value: cfg.wifi,
      note: ['Auto-detected at boot.', cfg.wifiCaveat].filter(Boolean).join(' '),
    },
  ];
}

/**
 * ESGe! status as a 3-bit field: bit 0 = Envision capable, bit 1 = boot flag,
 * bit 2 = currently on. Returns null if the reply is not a digit 0-7.
 */
export function parseESGe(reply) {
  const s = typeof reply === 'string' ? reply : DEC.decode(reply);
  const i = s.indexOf('ESGe');
  let r = (i >= 0 ? s.slice(i + 4) : s).trim();
  const bang = r.indexOf('!');
  if (bang >= 0) r = r.slice(0, bang);
  r = r.trim();
  if (!/^[0-7]$/.test(r)) return null;
  const v = Number(r);
  return { value: v, able: !!(v & 1), boot: !!(v & 2), on: !!(v & 4) };
}

/** Human-readable Fast Server status, matching the Dashboard's wording. */
export function fastServerText({ able, boot, on }) {
  if (!able) {
    return boot
      ? 'Not installed (boot flag set): update your WiFi firmware.'
      : 'Not installed: update your WiFi firmware.';
  }
  if (on && boot) return 'Enabled — running now.';
  if (on && !boot) return 'Running now (boot off).';
  if (boot) return 'Enabled.';
  return 'Available.';
}

/**
 * Read Envision / Fast Server status.
 *
 * ESGe! is not strictly side-effect free, but the one write it can do is
 * narrow and deliberate (GET_ENVISION_CAPABLE, firmware :6747-6802):
 *
 *   - RN-131 returns immediately with no AT traffic and no write.
 *   - Once ENVISION_ABLE / ENVISION_ON are known, later calls return from
 *     cache without touching the module at all.
 *   - Only when the module answers ERROR — i.e. it is not Envision-capable —
 *     does it SET.setBYTE(ENVISION_BOOT, 0) + commit, clearing a boot flag
 *     that is meaningless on such a module. The firmware comment says as
 *     much: "if not capable clear the boot flag no matter it was".
 *
 * So the write only lands on hardware where the flag should not have been set,
 * and only once. Safe to read as part of a normal identify.
 *
 * Skipped on RN-131, which the firmware reports as never capable anyway.
 */
export async function readEnvision(link, cfg, log = () => {}) {
  if (cfg.wifiType === 0) {
    return { skipped: true, text: 'Not available on RN-131 modules.' };
  }
  log('Reading Envision / Fast Server status (ESGe!)…');
  const raw = await link.send('ESGe!', { expect: 'ESGe', timeoutMs: 4000 });
  const parsed = parseESGe(raw);
  if (!parsed) return { skipped: false, text: 'Unknown (no usable response).', raw };
  // Codes 4 and 6 are "on but not capable", which cannot happen.
  if (parsed.on && !parsed.able) {
    return { skipped: false, ...parsed, text: `Unknown (impossible code ${parsed.value}).` };
  }
  return { skipped: false, ...parsed, text: fastServerText(parsed) };
}

/**
 * Identify the silicon from the Bin version line's parenthetical tag.
 *
 *   Bin version:ES4.2.30(WROOM-32)   -> ESP32
 *
 * This is the most direct answer available: the module states what it is,
 * rather than the mount inferring it. ESGi!'s `w` field only distinguishes
 * "answered AT with an ES-branded GMR" from "answered but not ES-branded",
 * so a stock-firmware ESP32 reads there as an ESP8266. The tag does not have
 * that failure mode.
 */
export function moduleFromBin(bin) {
  if (!bin) return { tag: null, module: null, moduleConfirmed: false };
  const m = bin.match(/\(([^)]+)\)/);
  const tag = m ? m[1].trim() : null;
  if (!tag) return { tag: null, module: null, moduleConfirmed: false };

  if (/WROOM-?32/i.test(tag)) return { tag, module: 'ESP32', moduleConfirmed: true };
  // Espressif's ESP8266 AT module is WROOM-02. Not yet seen on a real mount
  // here, so it is reported but not claimed as confirmed.
  if (/WROOM-?0?2\b/i.test(tag)) return { tag, module: 'ESP8266', moduleConfirmed: false };
  return { tag, module: null, moduleConfirmed: false };
}

/**
 * Parse an AT+GMR response, e.g.
 *
 *   AT version:2.2.0.0(s-ab8f5f8 - ESP32 - Jul 28 2021 07:05:28)
 *   SDK version:v4.3.1-0-g0e50573
 *   compile time(6118fc22):Feb 18 2022 07:32:35
 *   Bin version:ES2.2.0(WROOM-32)
 *   OK
 */
export function parseGmr(reply) {
  const s = (typeof reply === 'string' ? reply : DEC.decode(reply)).replace(/\r/g, '');

  // Values can WRAP across lines — real output has
  //   AT version:4.2.0.0-dev(bbccb5e - ESP32 - Feb
  //     9 2026 02:41:25)
  // so a field runs until the next known key, not until the next newline.
  const NEXT_KEY = /\n\s*(?:AT version:|SDK version:|compile time|Bin version:|OK\b|ERROR\b)/i;

  const grab = (keyRe) => {
    const m = keyRe.exec(s);
    if (!m) return null;
    const rest = s.slice(m.index + m[0].length);
    const stop = rest.search(NEXT_KEY);
    const chunk = stop >= 0 ? rest.slice(0, stop) : rest;
    return chunk.replace(/\s+/g, ' ').trim() || null;
  };

  const bin = grab(/Bin version:/i);
  return {
    at: grab(/AT version:/i),
    sdk: grab(/SDK version:/i),
    compileTime: grab(/compile time[^:\n]*:/i),
    bin,
    ...moduleFromBin(bin),
    // The firmware's own ESP32 test is literally the byte pair "ES" in the
    // AT+GMR output — the ES branding, not the "WROOM-32" chip name.
    esBranded: bin ? /^ES/i.test(bin) : false,
    raw: s.replace(/\r/g, '').trim(),
  };
}

/**
 * Read the Wi-Fi module's own version via AT+GMR.
 *
 * NOT read-only, and not part of identify(). This changes the Propeller's
 * mode: ESPw42! hands the USB line to the Wi-Fi module and blocks the ES
 * command interpreter until passthrough ends.
 *
 * The exit is `###` — a bare escape sequence, no terminator. It is sent in a
 * finally block so it runs even if the module never answers; leaving the mount
 * in passthrough would make it deaf to ES commands until power-cycled.
 *
 * Skipped on RN-131, which does not use the AT command set.
 */
export async function readEspVersion(transport, cfg, log = () => {}) {
  // Third possibility, and it must be refused before anything is sent: an
  // RN-131 is not an AT-command device at all. Its command mode works
  // differently, so ESPw42! + AT would be meaningless at best. The mount
  // reports the module in ESGi!'s `w` field and in the boot splash, so we
  // always know before committing to passthrough.
  if (cfg.wifiType === 0) {
    return {
      skipped: true,
      reason: 'RN-131 does not use the AT command set — passthrough not attempted.',
    };
  }

  const result = { skipped: false, entered: false, exited: false, gmr: null };

  log('Entering passthrough (ESPw42!)…');
  transport.flush();
  await transport.tx(ENC.encode('ESPw42!'));
  await sleep(400);
  result.entered = true;

  try {
    // The module usually ignores the first few AT probes; the firmware's own
    // detection sends AT twice and notes the first often returns ERROR.
    let ready = false;
    for (let i = 1; i <= 6 && !ready; i++) {
      transport.flush();
      await transport.tx(ENC.encode('AT\r\n'));
      const deadline = Date.now() + 600;
      let acc = '';
      while (Date.now() < deadline) {
        const d = await transport.rxTimeout(256, Math.max(50, deadline - Date.now()));
        if (d.length) acc += DEC.decode(d);
        if (/\bOK\b/.test(acc)) { ready = true; break; }
      }
      log(`  AT probe ${i}: ${ready ? 'OK' : (acc.trim() ? JSON.stringify(acc.trim()) : 'no reply')}`);
      if (!ready) await sleep(200);
    }

    // Send AT+GMR even without an OK. A missing OK is not proof the module is
    // deaf, and the version query is the only thing we came here for.
    if (!ready) log('  no OK from AT — trying AT+GMR anyway');

    transport.flush();
    await transport.tx(ENC.encode('AT+GMR\r\n'));

    // Stop on the last expected field rather than on OK: the reply arrives in
    // fragments (128-byte rings), spans blank lines, and OK may not appear.
    const deadline = Date.now() + 4000;
    let acc = '';
    let lastByteAt = Date.now();
    while (Date.now() < deadline) {
      const d = await transport.rxTimeout(512, Math.max(50, Math.min(300, deadline - Date.now())));
      if (d.length) { acc += DEC.decode(d); lastByteAt = Date.now(); }
      if (/Bin version:/i.test(acc) && Date.now() - lastByteAt > 250) break;
      if (/\bERROR\b/.test(acc)) break;
      if (acc && Date.now() - lastByteAt > 900) break;   // gone quiet
    }
    result.rawGmr = acc.replace(/\r/g, '').trim();
    result.gmr = parseGmr(acc);
    if (!result.gmr.at && !result.gmr.bin) {
      result.error = acc.trim()
        ? `AT+GMR returned nothing usable: ${JSON.stringify(result.rawGmr.slice(0, 200))}`
        : 'AT+GMR returned nothing at all.';
    }
  } finally {
    // Always leave passthrough, whatever happened above.
    log('Leaving passthrough (###)…');
    try {
      transport.flush();
      await transport.tx(ENC.encode('###'));
      const deadline = Date.now() + 2000;
      let acc = '';
      while (Date.now() < deadline) {
        const d = await transport.rxTimeout(256, Math.max(50, deadline - Date.now()));
        if (d.length) acc += DEC.decode(d);
        if (/exit/i.test(acc)) break;
      }
      result.exitMessage = acc.replace(/[\r\n]+/g, ' ').trim();
      result.exited = /exit/i.test(acc);
    } catch (e) {
      result.exitError = e.message;
    }
  }

  // Prove ES commands work again rather than assuming they do.
  try {
    const back = await ask(transport, 'ESGv!', { expect: 'ESGv', timeoutMs: 2000 });
    result.esRestored = back.includes('ESGv');
  } catch {
    result.esRestored = false;
  }
  log(result.esRestored
    ? 'ES commands confirmed working again.'
    : 'WARNING: ES commands did not answer after exiting passthrough.');

  return result;
}

/** Parse the ESGv reply: "ESGv" + build string + "!" (no CRLF terminator). */
export function parseESGv(reply) {
  const s = typeof reply === 'string' ? reply : DEC.decode(reply);
  const i = s.indexOf('ESGv');
  if (i < 0) throw new Error('Not an ESGv reply');
  const end = s.indexOf('!', i);
  if (end < 0) throw new Error('ESGv reply not terminated with "!"');
  // 1.x builds embed CRLF inside the build string — parse to "!", not to a
  // newline, then tidy.
  return s.slice(i + 4, end).replace(/[\r\n\0]/g, '').trim();
}

/**
 * Send one command and collect the reply.
 *
 * `expect` is the reply's leading token. We stop only once we have seen that
 * token AND a '!' after it — not merely any '!'. That matters because a mount
 * still printing its boot splash and spinner is emitting unrelated bytes
 * (including the '!' in "BT ON!") around our reply.
 */
export async function ask(transport, cmd, { timeoutMs = 2000, expect = null } = {}) {
  transport.flush();
  await transport.tx(ENC.encode(cmd));
  const deadline = Date.now() + timeoutMs;
  let acc = '';
  while (Date.now() < deadline) {
    const data = await transport.rxTimeout(256, Math.max(50, deadline - Date.now()));
    if (!data.length) continue;
    acc += DEC.decode(data);
    if (!expect) { if (acc.includes('!')) break; continue; }
    const i = acc.indexOf(expect);
    if (i >= 0 && acc.indexOf('!', i + expect.length) >= 0) break;
  }
  return acc;
}

/**
 * Full identify. Read-only: sends ESGv! and ESGi! and nothing else.
 * Never pulses reset — a mount mid-slew should not be interrupted.
 */
export async function identify(link, log = () => {}, { waitMs = 25000 } = {}) {
  // Opening the serial port can itself reset the mount: the OS driver may
  // assert DTR before the page can de-assert it, and DTR is wired to the
  // Propeller's reset line. The firmware then takes 15-20s to boot, during
  // which the command interpreter is not running and ESGv! is ignored.
  //
  // So poll rather than asking once. A single attempt reports "no reply" for
  // a mount that is merely rebooting, which sends people baud-rate hunting
  // for a problem they do not have.
  const deadline = Date.now() + waitMs;
  let vRaw = '';
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const left = Math.ceil((deadline - Date.now()) / 1000);
    log(attempt === 1
      ? 'Asking the mount for its firmware version (ESGv!)…'
      : `  no reply yet — the mount may be rebooting (${left}s left, attempt ${attempt})`);
    vRaw = await link.send('ESGv!', { expect: 'ESGv', timeoutMs: 2000 });
    if (vRaw.includes('ESGv')) break;
    await sleep(700);
  }

  if (!vRaw.includes('ESGv')) {
    throw new Error(
      `No reply to ESGv! after ${attempt} attempts over ${Math.round(waitMs / 1000)}s. ` +
      'Check the mount is powered and that this is the data cable, and close ' +
      'UFCT / the PMC8 Dashboard if either is holding the port.');
  }
  const firmware = parseESGv(vRaw);
  log(`Firmware: ${firmware}`);

  log('Asking the mount for its configuration (ESGi!)…');
  const iRaw = await link.send('ESGi!', { expect: 'ESGi' });
  const cfg = parseESGi(iRaw);
  log(`Model: ${cfg.model}   Wi-Fi module: ${cfg.wifi}`);

  return { firmware, ...cfg };
}

// A baud sweep used to live here. Removed: mounts are always at 115200, so it
// was a control that existed only to be left alone, and reopening the port per
// rate is slow and can reset the mount. BAUD_RATES above documents the legal
// set if a recovery path is ever genuinely needed.
