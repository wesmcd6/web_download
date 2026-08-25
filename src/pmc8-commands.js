/**
 * pmc8-commands.js — the ES command set, ported from the PMC8 Dashboard's
 * COMMANDS table (PMC8_Dashboard.py:140-316), with one addition.
 *
 * The addition is `risk`. The Dashboard sends whatever you pick, which is fine
 * for a desktop tool used by people who wrote the firmware. Here the same list
 * is reachable from a phone, so each entry carries what it actually does:
 *
 *   read    no side effects
 *   write   changes a stored setting, usually committing to EEPROM
 *   motion  moves a motor
 *   reboot  restarts the controller or the Wi-Fi module
 *
 * The label is shown next to the Send button. Nothing is blocked and nothing is
 * confirmed — this is a diagnostic console for someone who knows the command
 * set, and a prompt on every send would make it useless. The label exists so
 * that a motion or reboot command is not a surprise, not to gate it.
 */

export const COMMANDS = [
  // ---- reads --------------------------------------------------------------
  { key: 'ESGv!', risk: 'read', template: 'ESGv!', params: [],
    desc: 'Get firmware version' },
  { key: 'ESGi!', risk: 'read', template: 'ESGi!', params: [],
    desc: 'Retrieve all PMC8 configuration settings' },
  { key: 'ESGpA!', risk: 'read', template: 'ESGp{A}!',
    params: [{ name: 'A', label: 'Axis (0 = RA, 1 = DEC)' }],
    desc: 'Get axis A position, motor counts' },
  { key: 'ESGrA!', risk: 'read', template: 'ESGr{A}!',
    params: [{ name: 'A', label: 'Axis (0 = RA, 1 = DEC)' }],
    desc: 'Get axis A rate, motor counts per second (low resolution)' },
  { key: 'ESGtA!', risk: 'read', template: 'ESGt{A}!',
    params: [{ name: 'A', label: 'Axis (0 = RA, 1 = DEC)' }],
    desc: 'Get current target position for axis A, motor counts' },
  { key: 'ESGdA!', risk: 'read', template: 'ESGd{A}!',
    params: [{ name: 'A', label: 'Axis (0 = RA, 1 = DEC)' }],
    desc: 'Get current axis A direction' },
  { key: 'ESGfA!', risk: 'read', template: 'ESGf{A}!',
    params: [{ name: 'A', label: 'Axis (0 = RA, 1 = DEC)' }],
    desc: 'Get sidereal rate fraction for axis A' },
  { key: 'ESGcA!', risk: 'read', template: 'ESGc{A}!',
    params: [{ name: 'A', label: 'Mode (0 = Slew, 1 = Track)' }],
    desc: 'Get motor current value for slew or track' },
  { key: 'ESGw!', risk: 'read', template: 'ESGw!', params: [],
    desc: 'Get Wi-Fi channel' },
  { key: 'ESGq!', risk: 'read', template: 'ESGq!', params: [],
    desc: 'Get pulseguide state for motors 0 and 1' },
  { key: 'ESGx!', risk: 'read', template: 'ESGx!', params: [],
    desc: 'Get current tracking rate value (RA only, high resolution)' },
  { key: 'ESV!', risk: 'read', template: 'ESV!', params: [],
    desc: 'Request motor state vector' },

  // ---- reads with a caveat ------------------------------------------------
  { key: 'ESGe!', risk: 'write', template: 'ESGe!', params: [],
    desc: 'Get Envision (Fast Server) status — 3-bit field: 1 = capable, 2 = boot flag, 4 = currently on',
    note: 'Looks like a getter. If the module answers ERROR the firmware clears ' +
          'ENVISION_BOOT and commits — one EEPROM write, only on hardware where ' +
          'the flag was meaningless anyway.' },

  // ---- settings writes ----------------------------------------------------
  { key: 'ESSe<p>!', risk: 'reboot', template: 'ESSe{p}!',
    params: [{ name: 'p', label: '0 = stop now, 1 = start now, 3 = boot on, 4 = boot off' }],
    desc: 'Set Envision (Fast Server)',
    note: '0 and 1 reboot the Wi-Fi module and take ~20s. 3 and 4 only set the ' +
          'boot flag. A bare "ESSe!" reply means the command was rejected.' },
  { key: 'ESSwDD!', risk: 'write', template: 'ESSw{channel}!',
    params: [{ name: 'channel', label: 'Wi-Fi channel, decimal (0-11)' }],
    desc: 'Set Wi-Fi channel' },
  { key: 'ESScAZZZZ!', risk: 'write', template: 'ESSc{A}{current}!',
    params: [{ name: 'A', label: 'Mode (0 = Slew, 1 = Track)' },
             { name: 'current', label: 'Current in decimal mA, e.g. 0123' }],
    desc: 'Set motor current value' },
  { key: 'ESSfAXXXX!', risk: 'write', template: 'ESSf{A}{value}!',
    params: [{ name: 'A', label: 'Axis (0 = RA, 1 = DEC)' },
             { name: 'value', label: 'Sidereal rate fraction, 4 hex digits (0 < v <= 100)' }],
    desc: 'Set sidereal rate fraction for axis A' },

  // ---- toggles: innocuous-looking, but each commits ------------------------
  { key: 'ESH!', risk: 'write', template: 'ESH!', params: [],
    desc: 'Toggle Northern/Southern hemisphere (1 = North, 0 = South)' },
  { key: 'ESW!', risk: 'write', template: 'ESW!', params: [],
    desc: 'Toggle comms watchdog (1 = keep tracking, 0 = stop on lost comms)' },
  { key: 'ESM!', risk: 'motion', template: 'ESM!', params: [],
    desc: 'Toggle sidereal rate at boot (0 = boot stopped, 1 = boot RA at sidereal)',
    note: 'Also calls Compute_M_STEP, which STARTS THE RA MOTOR immediately.' },
  { key: 'ESY!', risk: 'reboot', template: 'ESY!', params: [],
    desc: 'Toggle IP protocol (0 = TCP, 1 = UDP)',
    note: 'Reboots the controller.' },
  { key: 'ESB!', risk: 'reboot', template: 'ESB!', params: [],
    desc: 'Boot (restart) the PMC-Eight controller' },

  // ---- motion -------------------------------------------------------------
  { key: 'ESPtAYYYYYY!', risk: 'motion', template: 'ESPt{A}{value}!',
    params: [{ name: 'A', label: 'Axis (0 = RA, 1 = DEC)' },
             { name: 'value', label: 'Target position, 6 hex digits (motor counts)' }],
    desc: 'Point (slew) to target on axis A using ramps' },
  { key: 'ESSpAYYYYYY!', risk: 'motion', template: 'ESSp{A}{value}!',
    params: [{ name: 'A', label: 'Axis (0 = RA, 1 = DEC)' },
             { name: 'value', label: 'Position, 6 hex digits' }],
    desc: 'Set axis A position value' },
  { key: 'ESSrAXXXX!', risk: 'motion', template: 'ESSr{A}{value}!',
    params: [{ name: 'A', label: 'Axis (0/1 low res, 4/5 high res)' },
             { name: 'value', label: 'Rate, 4 hex digits' }],
    desc: 'Set rate value for axis A' },
  { key: 'ESSdAD!', risk: 'motion', template: 'ESSd{A}{D}!',
    params: [{ name: 'A', label: 'Axis (0 = RA, 1 = DEC)' },
             { name: 'D', label: 'Direction (0 or 1)' }],
    desc: 'Set direction for axis A' },
  { key: 'ESSqADHHHH!', risk: 'motion', template: 'ESSq{A}{D}{time}!',
    params: [{ name: 'A', label: 'Axis (0 = RA, 1 = DEC)' },
             { name: 'D', label: 'Direction (0 or 1)' },
             { name: 'time', label: 'Time in ms, 4 hex digits' }],
    desc: 'Pulse guide' },
  { key: 'ESTrXXXX!', risk: 'motion', template: 'ESTr{value}!',
    params: [{ name: 'value', label: 'RA tracking rate, 4 hex digits' }],
    desc: 'Set RA tracking rate (high precision, 25x the desired pulse rate)' },
  { key: 'ESTeAXXXX!', risk: 'motion', template: 'ESTe{A}{value}!',
    params: [{ name: 'A', label: 'Axis (0 = RA, 1 = DEC)' },
             { name: 'value', label: 'Tracking rate, 4 hex digits' }],
    desc: 'Set tracking rate for axis A (high precision)' },
];

export const RISK_LABEL = {
  read: 'Read only',
  write: 'Changes a stored setting',
  motion: 'Can move a motor',
  reboot: 'Restarts the controller or module',
};

/** Substitute {name} placeholders. Throws if a parameter is blank. */
export function buildCommand(cmd, values = {}) {
  let out = cmd.template;
  for (const p of cmd.params) {
    const v = String(values[p.name] ?? '').trim();
    if (!v) throw new Error(`${p.label} is required`);
    if (/[!{}\s]/.test(v)) throw new Error(`${p.label}: "${v}" contains an illegal character`);
    out = out.replace(`{${p.name}}`, v);
  }
  const leftover = out.match(/\{(\w+)\}/);
  if (leftover) throw new Error(`Missing value for ${leftover[1]}`);
  return out;
}

/**
 * Classify a hand-typed command by matching its prefix against the table.
 * Returns the riskiest match, or null when nothing matches — an unknown
 * command is treated as unknown rather than assumed safe.
 */
export function classify(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  // %%% enters diagnostic mode and DISABLES the ES command set entirely.
  if (s.includes('%%%')) {
    return { risk: 'reboot', desc: 'Enter diagnostic mode',
             note: 'This DISABLES the ES command set until the controller is ' +
                   'restarted. Almost never what you want.' };
  }
  if (s.startsWith('ESPw')) {
    return { risk: 'reboot', desc: 'Enter passthrough mode',
             note: 'Hands the USB line to the Wi-Fi module and blocks the ES ' +
                   'command interpreter until ### is sent.' };
  }

  // Longest literal prefix wins, so ESSe beats ESS.
  let best = null;
  for (const c of COMMANDS) {
    const prefix = c.template.split('{')[0];
    if (prefix && s.startsWith(prefix) &&
        (!best || prefix.length > best.template.split('{')[0].length)) {
      best = c;
    }
  }
  return best;
}
