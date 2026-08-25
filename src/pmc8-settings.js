/**
 * pmc8-settings.js — build and send ESSi! to change stored mount settings.
 *
 * Everything here is derived from the firmware, not from the Dashboard, with
 * two deliberate differences from it — see below.
 *
 * ESSi layout (SerialMirror_20A02.1.1.spin:1036-1095). Each field is read with
 * Get_CMD_DATA(type, number, cmd, value_test) -> GetNumber(.., type, number),
 * and **type 0 means DECIMAL** (documented at SerialMirror:578). So P9 goes out
 * in decimal, exactly as ESGi! prints it — the two round-trip directly.
 *
 *   ESSi bbbbbb 2 4 5 6 777 888 99 mmmm MMMM WW S !      = 34 bytes
 *
 * ⚠ ESSi consumes TWELVE fields and stops at ST4_Disable (:1091), then commits
 * (:1094). ST4 Type and WiFi Type are NOT settable — Wi-Fi type is auto-
 * detected at boot, so there would be nothing to set. The PMC8 Dashboard
 * appends both anyway (PMC8_Configurator.py:874-875), producing a 36-byte
 * string whose last two characters the parser never reads; they fall through to
 * the extraneous-byte filter. We send 34 and leave nothing dangling.
 *
 * Reply (20A02.2.0.1.bt.spin:4332-4340):
 *   "ESGi!"        (5 bytes, no payload) -> REJECTED, nothing committed
 *   "ESGi....!"    (36 bytes)            -> ACCEPTED, and this is the new config
 *
 * A rejected field aborts the whole command, but note the firmware's own
 * comment at :1094: fields parsed before the bad one are already live in RAM
 * until reboot, even though nothing was committed to EEPROM.
 */

import { parseESGi } from './pmc8-identify.js';

/** The twelve fields ESSi! actually writes, in wire order. */
export const EDITABLE_FIELDS = [
  {
    key: 'baud', label: 'Baud Rate', width: 6, kind: 'select',
    options: [115200, 57600, 38400, 19200, 14400, 9600].map((v) => ({ value: v, label: String(v) })),
    warn: 'Changing this makes the mount boot at a different rate. This tool ' +
          'only speaks 115200, so anything else will make it unreachable here.',
  },
  {
    key: 'tcpip', label: 'IP Protocol', width: 1, kind: 'select',
    options: [{ value: 0, label: 'TCP' }, { value: 1, label: 'UDP' }],
    from: (c) => (c.tcpip ? 0 : 1),
  },
  {
    key: 'trackOnCommsLoss', label: 'Continuous Track', width: 1, kind: 'select',
    options: [{ value: 1, label: 'On' }, { value: 0, label: 'Off' }],
    from: (c) => (c.trackOnCommsLoss ? 1 : 0),
  },
  {
    key: 'raRunOnBoot', label: 'Run on Boot', width: 1, kind: 'select',
    options: [{ value: 1, label: 'YES' }, { value: 0, label: 'NO' }],
    from: (c) => (c.raRunOnBoot ? 1 : 0),
  },
  {
    key: 'hemisphere', label: 'Hemisphere', width: 1, kind: 'select',
    options: [{ value: 1, label: 'North' }, { value: 0, label: 'South' }],
    from: (c) => (c.hemisphere === 'North' ? 1 : 0),
  },
  {
    key: 'guideRateRA', label: 'Sidereal Rate Fraction RA %', width: 3,
    kind: 'number', min: 0, max: 999,
  },
  {
    key: 'guideRateDec', label: 'Sidereal Rate Fraction DEC %', width: 3,
    kind: 'number', min: 0, max: 999,
  },
  {
    key: 'p9', label: 'Mount Type', width: 2, kind: 'select',
    // Values are P9 as the firmware stores it; ESSi parses them in decimal.
    //
    // ALL SIXTEEN are listed, not just one per model. G-11 occupies 4-7 and
    // EXOS-2 occupies 8-11, so a mount sitting on 5 or 9 is perfectly normal —
    // offering only 4 and 8 would make its current value unselectable and
    // wedge the form on a validation error it could not clear.
    options: [
      { value: 0, label: 'iEXOS-100 (original board)' },
      { value: 1, label: 'iEXOS-100' },
      { value: 2, label: 'iEXOS-200' },
      { value: 3, label: 'iEXOS-300' },
      { value: 4, label: 'G-11' },
      { value: 5, label: 'G-11 (5)' },
      { value: 6, label: 'G-11 (6)' },
      { value: 7, label: 'G-11 (7)' },
      { value: 8, label: 'EXOS-2' },
      { value: 9, label: 'EXOS-2 (9)' },
      { value: 10, label: 'EXOS-2 (10)' },
      { value: 11, label: 'EXOS-2 (11)' },
      { value: 12, label: 'iEXOS-100 (Scotty)' },
      { value: 13, label: 'Titan' },
      { value: 14, label: 'MSR EQ' },
      { value: 15, label: 'ASKO SX260S' },
    ],
    warn: 'Sets the mount model. Motor currents, sidereal rates and axis ' +
          'reversal all follow from this — setting it wrong will make the ' +
          'mount track and slew incorrectly.',
  },
  {
    key: 'slewCurrentMa', label: 'Motor Current Slew, ma', width: 4,
    kind: 'number', min: 0, max: 9999,
    warn: 'The firmware clamps this to the legal range for the mount type at ' +
          'next boot.',
  },
  {
    key: 'trackCurrentMa', label: 'Motor Current Track, ma', width: 4,
    kind: 'number', min: 0, max: 9999,
  },
  {
    key: 'wifiChannel', label: 'WiFi Channel', width: 2,
    kind: 'number', min: 0, max: 14,
    warn: 'Channel 0 makes the firmware print a warning at boot.',
  },
  {
    key: 'st4Disabled', label: 'ST4 Status', width: 1, kind: 'select',
    options: [{ value: 0, label: 'Enabled' }, { value: 1, label: 'Disabled' }],
    from: (c) => (c.st4Disabled ? 1 : 0),
  },
];

/** Read-only fields: present in ESGi!, not accepted by ESSi!. */
export const READ_ONLY_FIELDS = [
  { key: 'st4Analog', label: 'ST4 Type', reason: 'Not settable via ESSi.' },
  { key: 'wifiType', label: 'WiFi Type', reason: 'Auto-detected at boot.' },
];

/** Current wire values for every editable field, taken from a parsed ESGi. */
export function currentValues(cfg) {
  const out = {};
  for (const f of EDITABLE_FIELDS) {
    out[f.key] = f.from ? f.from(cfg) : cfg[f.key];
  }
  return out;
}

/**
 * Build the ESSi! command from a {key: number} map.
 * Throws on anything that would not survive the firmware's length checks —
 * each field is length-tested, and a bad one aborts the whole command.
 */
export function buildESSi(values) {
  let cmd = 'ESSi';
  for (const f of EDITABLE_FIELDS) {
    const raw = values[f.key];
    const n = Number(raw);
    if (raw === '' || raw == null || !Number.isFinite(n) || !Number.isInteger(n)) {
      throw new Error(`${f.label}: "${raw}" is not a whole number`);
    }
    if (n < 0) throw new Error(`${f.label}: cannot be negative`);
    if (f.kind === 'select' && !f.options.some((o) => o.value === n)) {
      throw new Error(`${f.label}: ${n} is not one of the allowed values`);
    }
    if (f.kind === 'number' && (n < f.min || n > f.max)) {
      throw new Error(`${f.label}: ${n} is outside ${f.min}–${f.max}`);
    }
    const s = String(n).padStart(f.width, '0');
    // A value too wide would shift every later field and silently corrupt them.
    if (s.length !== f.width) {
      throw new Error(`${f.label}: ${n} does not fit in ${f.width} digits`);
    }
    cmd += s;
  }
  return `${cmd}!`;
}

/** Fields whose value differs from the mount's current config. */
export function changedFields(cfg, values) {
  const now = currentValues(cfg);
  return EDITABLE_FIELDS
    .filter((f) => Number(now[f.key]) !== Number(values[f.key]))
    .map((f) => ({
      ...f,
      was: now[f.key],
      now: Number(values[f.key]),
      label: f.label,
    }));
}

/** Render a field value the way the UI shows it, for confirmation text. */
export function displayValue(field, value) {
  if (field.kind === 'select') {
    return field.options.find((o) => o.value === Number(value))?.label ?? String(value);
  }
  return String(value);
}

/**
 * Send ESSi! and interpret the reply.
 *
 * Returns { accepted, cfg, sent, raw }. `cfg` is the mount's echoed
 * configuration after the write, so the caller can verify the change landed
 * rather than trusting the command.
 */
export async function writeSettings(link, values, log = () => {}) {
  const sent = buildESSi(values);
  log(`Sending ${sent}`);

  const raw = await link.send(sent, { expect: 'ESGi', timeoutMs: 4000 });
  const i = raw.indexOf('ESGi');
  if (i < 0) {
    return { accepted: false, sent, raw, error: 'No reply from the mount.' };
  }

  const body = raw.slice(i);
  // A bare "ESGi!" is the rejection; a full block is the acceptance.
  if (/^ESGi!/.test(body)) {
    return {
      accepted: false, sent, raw,
      error: 'The mount rejected the settings — nothing was committed. ' +
             'One of the values failed its length check.',
    };
  }

  let cfg = null;
  try {
    cfg = parseESGi(body);
  } catch (e) {
    return { accepted: false, sent, raw, error: `Unreadable reply: ${e.message}` };
  }
  return { accepted: true, sent, raw, cfg };
}
