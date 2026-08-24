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

/** Legal baud rates the firmware will accept; it defaults to 115200. */
export const BAUD_RATES = [115200, 9600, 19200, 38400, 57600, 14400];

/**
 * P9 -> mount model. The firmware prints P9 as DECIMAL in the ESGi reply but
 * parses it as HEX on input, so the printed "15" is P9 value 15 (0xF).
 * Read the field with parseInt(.., 10) — base 16 would silently mangle it.
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

/** Send one command and collect the reply up to '!' (or until quiet). */
export async function ask(transport, cmd, { timeoutMs = 1500, want = '!' } = {}) {
  transport.flush();
  await transport.tx(ENC.encode(cmd));
  const deadline = Date.now() + timeoutMs;
  let acc = '';
  while (Date.now() < deadline) {
    const data = await transport.rxTimeout(256, Math.max(50, deadline - Date.now()));
    if (data.length) {
      acc += DEC.decode(data);
      if (want && acc.includes(want) && acc.indexOf(want) > 3) break;
    }
  }
  return acc;
}

/**
 * Full identify. Read-only: sends ESGv! and ESGi! and nothing else.
 * Never pulses reset — a mount mid-slew should not be interrupted.
 */
export async function identify(transport, log = () => {}) {
  log('Asking the mount for its firmware version (ESGv!)…');
  const vRaw = await ask(transport, 'ESGv!');
  if (!vRaw.trim()) {
    throw new Error(
      'No reply to ESGv!. Check the mount is powered and the cable is the ' +
      'data cable, then try the other baud rates — a previous ESSi! can ' +
      'leave the mount booting at 9600–57600 instead of 115200.');
  }
  const firmware = parseESGv(vRaw);
  log(`Firmware: ${firmware}`);

  log('Asking the mount for its configuration (ESGi!)…');
  const iRaw = await ask(transport, 'ESGi!');
  const cfg = parseESGi(iRaw);
  log(`Model: ${cfg.model}   Wi-Fi module: ${cfg.wifi}`);

  return { firmware, ...cfg };
}

/**
 * Try each legal baud rate until ESGv! answers. Used only when the user asks
 * for it — reopening the port is slow, and on Linux it can reset the mount.
 */
export async function autoBaud(makeTransport, log = () => {}) {
  for (const baud of BAUD_RATES) {
    log(`Trying ${baud} baud…`);
    const t = await makeTransport(baud);
    try {
      const reply = await ask(t, 'ESGv!', { timeoutMs: 900 });
      if (reply.includes('ESGv')) { log(`Answered at ${baud}.`); return { transport: t, baud }; }
    } catch { /* fall through to next rate */ }
    await t.close();
    await sleep(120);
  }
  throw new Error('No reply at any of the six legal baud rates.');
}
