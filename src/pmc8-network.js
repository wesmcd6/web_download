/**
 * pmc8-network.js — join the mount's Wi-Fi module to a home network, and read
 * back the address it was given.
 *
 * Ported from the PMC8 Dashboard's Network tab (PMC8-Dashboard/
 * network_management.py), command sequences and settle timings included. Three
 * modules, three completely different command sets:
 *
 *   ESP32 / ESP8266   AT commands through passthrough
 *   RN-131            WiFly command mode inside passthrough
 *
 * Everything runs over the serial cable. Wi-Fi cannot configure Wi-Fi — you
 * would be cutting the link you are talking over.
 */

import {
  ENC, DEC, sleep, line, inCommandMode, clearLine, reenterCommandMode,
} from './pmc8-rn131.js';
import { parseESGe } from './pmc8-identify.js';

/** Pull the first dotted-quad out of a module reply. */
export function extractIp(text) {
  const m = String(text ?? '').match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
  return m ? m[1] : null;
}

/**
 * Encode an SSID or passphrase for a WiFly `set wlan …` command.
 *
 * WiFly tokenises the command line on spaces, so `set wlan pass a b c` stores
 * only "a" — the module then fails authentication (AUTH-ERR) and loops trying
 * to join. WiFly's convention is to send each space as '$', which it converts
 * back when storing. Only the on-wire value is encoded.
 *
 * A literal '$' cannot be represented at all, since WiFly would read it back as
 * a space. Callers must warn rather than silently mangle the credential.
 */
export function wiflyValue(value) {
  return String(value ?? '').replace(/ /g, '$');
}

/** True when the value contains something WiFly cannot carry. */
export function wiflyUnsendable(value) {
  return String(value ?? '').includes('$');
}

// ── AT plumbing (ESP32 / ESP8266) ───────────────────────────────────────────

/**
 * Settle after each AT command before reading. The ESP32 turns a command around
 * more slowly than the ESP8266, so it gets longer; both have headroom, and
 * going too fast produces the AT firmware's "busy p..." notice.
 */
const AT_SETTLE = { ESP32: 600, ESP8266: 350 };

async function at(transport, cmd, { want = 'OK', tries = 10, perRead = 300, settle = 350 } = {}) {
  transport.flush();
  await transport.tx(ENC.encode(`${cmd}@`));
  await sleep(settle);

  let acc = '';
  for (let i = 0; i < tries; i++) {
    const d = await transport.rxTimeout(512, perRead);
    if (d.length) {
      acc += DEC.decode(d);
      if (want && acc.includes(want)) break;
    } else if (acc && !want) {
      break;
    }
    // A gap is not the end of a slow reply when we are waiting for a token —
    // the AT firmware can interpose "busy p..." before the real result.
  }
  return acc.replace(/\r/g, '');
}

/** Enter the Propeller's passthrough so AT/WiFly commands reach the module. */
async function enterPassthrough(transport) {
  transport.flush();
  await transport.tx(ENC.encode('ESPw42!'));
  await sleep(300);
  const echo = DEC.decode(await transport.rxTimeout(256, 600)).trim();
  transport.flush();
  return echo;
}

/** Leave passthrough. Bare '###', no '@' — it is not a module command. */
async function exitPassthrough(transport) {
  try {
    transport.flush();
    await transport.tx(ENC.encode('###'));
    await sleep(500);
    return DEC.decode(await transport.rxTimeout(256, 500)).replace(/[\r\n]+/g, ' ').trim();
  } catch {
    return '';
  }
}

/**
 * Envision takes over the AT command processor, so every AT operation fails
 * while it is running. Stop it first and tell the caller, so it can be put back.
 * RN-131 has no Envision — never probe it there.
 */
async function suspendEnvision(link, module, log) {
  if (module === 'RN131') return false;
  try {
    const st = parseESGe(await link.send('ESGe!', { expect: 'ESGe', timeoutMs: 3000 }));
    if (!st || !st.on) return false;
    log('Envision (Fast Server) is running — stopping it so the AT processor is free.',
        't-warn');
    await link.send('ESSe0!', { timeoutMs: 3000 });
    await sleep(5000);          // the module reboots on the way out
    return true;
  } catch (e) {
    log(`Envision pre-check skipped: ${e.message}`, 't-dim');
    return false;
  }
}

async function restoreEnvision(link, wasActive, log) {
  if (!wasActive) return;
  log('Putting Envision back on (ESSe1!)…');
  try {
    await link.send('ESSe1!', { timeoutMs: 4000 });
  } catch (e) {
    log(`Could not restart Envision: ${e.message}`, 't-warn');
  }
}

// ── read the current address ────────────────────────────────────────────────

/**
 * Read the module's Wi-Fi address. Returns { ip, apIp, raw }.
 * `module` is 'ESP32' | 'ESP8266' | 'RN131'.
 */
export async function readWifiAddress(link, module, log = () => {}) {
  const transport = link.transport;
  const wasEnvision = await suspendEnvision(link, module, log);
  const settle = AT_SETTLE[module] ?? 350;

  try {
    log(`Reading the current ${module} Wi-Fi address…`);
    await enterPassthrough(transport);

    if (module === 'RN131') {
      if (!await ensureCommandMode(transport, log)) {
        return { ip: null, raw: '', error: 'Could not put the RN-131 into command mode.' };
      }
      await clearLine(transport);
      const r = await line(transport, 'get ip a', 3000);
      // "?-" means the module lost the command's first character. The VB tool
      // retries here rather than reporting a failure, and so do we.
      let raw = r.raw;
      if (/\?-/.test(raw)) {
        log('  module garbled the command (?-) — retrying…', 't-warn');
        await clearLine(transport);
        raw = (await line(transport, 'get ip a', 3000)).raw;
      }
      await line(transport, 'exit', 1200);          // back to data mode
      return { ip: extractIp(raw), raw };
    }

    // ESP: probe for a live AT interface first — it also clears the echo.
    let found = false;
    for (let i = 0; i < 3 && !found; i++) {
      found = (await at(transport, 'AT', { want: 'OK', tries: 6, settle })).includes('OK');
    }
    log(found ? '  module answered AT with OK.' : '  WARNING: no AT OK — check the module type.',
        found ? 't-ok' : 't-warn');

    if (module === 'ESP8266') {
      // AT+CIFSR lists BOTH the soft-AP address and the station address. On a
      // freshly booted mount the AP is 192.168.47.1 and STAIP is 0.0.0.0;
      // after joining, STAIP holds the DHCP address.
      const raw = await at(transport, 'AT+CIFSR', { want: 'STAIP', tries: 12, perRead: 400, settle });
      const sta = raw.split('STAIP')[1] ?? '';
      const ap = raw.split('APIP')[1] ?? '';
      return { ip: extractIp(sta), apIp: extractIp(ap), raw };
    }

    const staRaw = await at(transport, 'AT+CIPSTA?', { want: 'OK', tries: 12, perRead: 400, settle });
    const apRaw = await at(transport, 'AT+CIPAP?', { want: 'OK', tries: 12, perRead: 400, settle });
    return { ip: extractIp(staRaw), apIp: extractIp(apRaw), raw: `${staRaw}\n${apRaw}` };
  } finally {
    await exitPassthrough(transport);
    await restoreEnvision(link, wasEnvision, log);
  }
}

// ── join a home network ─────────────────────────────────────────────────────

/** RN-131 command mode, using the probe-first rule that passthrough needs. */
async function ensureCommandMode(transport, log) {
  if (await inCommandMode(transport)) {
    log('  module was already in command mode.', 't-dim');
    return true;
  }
  for (let i = 1; i <= 3; i++) {
    if (await reenterCommandMode(transport)) return true;
    if (await inCommandMode(transport)) return true;   // CMD can be missed
    if (i < 3) log(`  no CMD — sending $$$ again (attempt ${i + 1})…`, 't-warn');
  }
  return false;
}

/** The WiFly join sequence, verbatim from the Dashboard. */
export const RN131_JOIN_COMMANDS = [
  'set wlan ssid {ssid}',
  'set wlan pass {pass}',
  'set wlan join 1',
  'set wlan chan 0',
  'set ip dhcp 1',
  'set ip host 0.0.0.0',
  'set comm remote 1',
  'set ip remote 0',
  'save',
];

/** Build the RN-131 join sequence with the credentials substituted in. */
export function rn131JoinSequence(ssid, password) {
  return RN131_JOIN_COMMANDS.map((c) => c
    .replace('{ssid}', wiflyValue(ssid))
    .replace('{pass}', wiflyValue(password)));
}

/**
 * Join the module to a home network. Returns { ok, ip, error }.
 */
export async function configureHomeNetwork(link, module, ssid, password, log = () => {},
                                           onStep = () => {}) {
  if (!ssid.trim()) return { ok: false, error: 'Enter the home Wi-Fi SSID.' };

  const transport = link.transport;
  const wasEnvision = await suspendEnvision(link, module, log);
  const settle = AT_SETTLE[module] ?? 350;

  try {
    log(`Configuring ${module} for home network "${ssid}"…`);
    await enterPassthrough(transport);

    if (module === 'RN131') {
      if (wiflyUnsendable(ssid) || wiflyUnsendable(password)) {
        log('WARNING: a literal "$" in the SSID or password cannot be sent to an ' +
            'RN-131 — WiFly reads "$" as a space. If the join fails, this module ' +
            'cannot use that password.', 't-warn');
      }
      if (/ /.test(ssid) || / /.test(password)) {
        log('Note: encoding spaces as "$" for the RN-131 (WiFly space convention).',
            't-dim');
      }

      if (!await ensureCommandMode(transport, log)) {
        return { ok: false, error: 'Could not put the RN-131 into command mode.' };
      }
      await clearLine(transport);

      const seq = rn131JoinSequence(ssid, password);
      for (let i = 0; i < seq.length; i++) {
        const r = await line(transport, seq[i], 2500);
        onStep(i + 1, seq.length + 1, seq[i]);
        // Never echo the passphrase back into the log.
        const shown = seq[i].startsWith('set wlan pass') ? 'set wlan pass ********' : seq[i];
        log(`  ${shown} → ${r.reply || (r.silent ? 'no reply' : 'sent')}`,
            r.err ? 't-err' : 't-ok');
      }

      log('Rebooting the module and waiting for it to join…');
      await line(transport, 'reboot', 1500);
      onStep(seq.length + 1, seq.length + 1, 'reboot');
      await sleep(8000);

      // The reboot drops command mode but NOT the Propeller's passthrough, so
      // only the escape needs re-sending.
      if (!await ensureCommandMode(transport, log)) {
        return { ok: true, ip: null, error:
          'Configured, but could not re-enter command mode to read the address — ' +
          'the module may still be joining. Use Get Wi-Fi address in a moment.' };
      }
      await clearLine(transport);
      const got = await line(transport, 'get ip a', 3000);
      await line(transport, 'exit', 1200);
      const ip = extractIp(got.raw);
      return { ok: true, ip, raw: got.raw };
    }

    // ── ESP32 / ESP8266 ───────────────────────────────────────────────
    let found = false;
    for (let i = 0; i < 3 && !found; i++) {
      found = (await at(transport, 'AT', { want: 'OK', tries: 6, settle })).includes('OK');
    }
    log(found ? '  module answered AT with OK.' : '  WARNING: no AT OK — check the module type.',
        found ? 't-ok' : 't-warn');
    onStep(1, 4, 'AT');

    const mode = await at(transport, 'AT+CWMODE=1', { want: 'OK', settle });
    log(`  station mode: ${mode.includes('OK') ? 'OK' : '?'}`,
        mode.includes('OK') ? 't-ok' : 't-warn');
    onStep(2, 4, 'CWMODE');

    log('  joining the home network (this can take several seconds)…');
    const join = await at(transport, `AT+CWJAP="${ssid}","${password}"`,
                          { want: 'GOT', tries: 30, perRead: 500, settle });
    const joined = join.includes('GOT');
    await at(transport, '', { want: 'OK', tries: 10, settle: 0 }).catch(() => {});
    log(joined ? '  joined the home network.' : '  WARNING: never saw "WIFI GOT IP".',
        joined ? 't-ok' : 't-warn');
    onStep(3, 4, 'CWJAP');

    const raw = await at(transport, module === 'ESP8266' ? 'AT+CIFSR' : 'AT+CIPSTA?',
                         { want: '192', tries: 12, perRead: 400, settle });
    onStep(4, 4, 'address');
    const ip = extractIp(module === 'ESP8266' ? (raw.split('STAIP')[1] ?? raw) : raw);
    return { ok: joined || !!ip, ip, raw, joined };
  } finally {
    // MUST run on success and on error, or the mount is left in passthrough.
    await exitPassthrough(transport);
    await restoreEnvision(link, wasEnvision, log);
  }
}
