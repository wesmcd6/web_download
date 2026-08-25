/**
 * pmc8-rn131.js — restore an RN-131 Wi-Fi module to the Explore Scientific
 * factory configuration.
 *
 * Ported from UFCT's btnRestoreRn131_Click (pmc-eight-ufct/Form1.Wifi.vb:182),
 * same commands in the same order, including the intermediate saves.
 *
 * Wire format, and the part that is easy to get wrong:
 *
 *   ESPw42!   puts the Propeller into passthrough, bridging USB to the module
 *   $$$       the RN-131's own escape into command mode (no terminator)
 *   <cmd>@    every config command ends with '@'
 *   ###       leaves passthrough
 *
 * The '@' is NOT part of the RN-131 syntax. Inside passthrough the Propeller
 * treats '@' as a reserved byte: it is not forwarded, and instead a CRLF is
 * written to the module (SerialMirror_20A02.1.1.spin:663). So '@' is how you
 * press Enter through the bridge. Sending "\r\n" would be forwarded literally
 * and the module would never see a line ending.
 *
 * The intermediate saves are deliberate — the RN-131 has limited config memory
 * and UFCT commits in batches rather than once at the end.
 */

const ENC = new TextEncoder();
const DEC = new TextDecoder('latin1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The factory configuration, batched exactly as UFCT commits it. */
export const RN131_RESTORE_GROUPS = [
  { title: 'Comms and DNS', cmds: [
    'set comm size 64',
    'set dns addr 0.0.0.0',
    'set dns backup 0.0.0.0',
    'set dns name dns1',
  ] },
  { title: 'FTP and DHCP', cmds: [
    'set ftp addr 0.0.0.0',
    'set ftp time 200',
    'set ip dhcp 4',
    'set ip flag 0x47',
  ] },
  { title: 'Soft-AP addressing', cmds: [
    'set ip gate 192.168.47.1',
    'set ip addr 192.168.47.1',
    'set ip net 255.255.0.0',
  ] },
  { title: 'Protocol and ports', cmds: [
    'set ip host 0.0.0.0',
    'set ip protocol 0x03',
    'set ip remote 54372',
    'set ip local 54372',
  ] },
  { title: 'Sleep and wake', cmds: [
    'set sys autosleep 0',
    'set sys sleep 0',
    'set sys wake 5',
    'set sys trigger 0x01',
  ] },
  { title: 'WLAN', cmds: [
    'set wlan auth 4',
    'set wlan hide 1',
    'set wlan join 7',
    'set wlan chan 11',
  ] },
  { title: 'Identity', cmds: [
    'set opt deviceid PMC-Eight',
    'set wlan passphrase PMC-Eight',
    'set apmode passphrase PMC-Eight',
    'set wlan ext_antenna 1',
  ] },
];

/** Every config command in order, for display and for counting progress. */
export function restoreCommandList() {
  return RN131_RESTORE_GROUPS.flatMap((g) => [...g.cmds, 'save']);
}

/** Total steps including the final reboot, for a progress readout. */
export const RESTORE_STEP_COUNT = restoreCommandList().length + 1;

/**
 * A restore only succeeded if every command was confirmed.
 *
 * An unanswered command is NOT a success. Treating silence as success reported
 * green while seven commands had gone unconfirmed, which is worse than
 * reporting nothing — the user walks away believing the module was restored.
 */
export function restoreSucceeded({ failures = [], silent = [] } = {}) {
  return failures.length === 0 && silent.length === 0;
}

/**
 * Send one line through passthrough and read the module's answer.
 *
 * In command mode the RN-131 echoes the command, then answers `AOK` or
 * `ERR: …`, then prints its prompt `<4.41>`. So there is a definite
 * end-of-response to wait for — poll until one of those appears rather than
 * sleeping a fixed time and hoping.
 *
 * Two things an earlier version got wrong, both of which made every command
 * look silent:
 *   - it flushed the buffer BEFORE each command, discarding the previous
 *     command's late reply, so a slow answer was attributed to the next
 *     command or lost entirely;
 *   - it read for a fixed 200 ms, which is shorter than the module often
 *     takes, so most replies were simply missed.
 */
/**
 * WiFly status notices that mean a TCP client is talking to the module while we
 * are trying to configure it. `*OPEN*` / `*CLOS*` bracket a connection, and the
 * ES command that follows (`ESV!` and friends) is that client's traffic being
 * forwarded through the very link we are using. It corrupts replies and can
 * drop the module out of command mode.
 */
const INTERFERENCE = /\*OPEN\*|\*CLOS\*|ES[A-Z]/;

/** Settle after writing before reading — UFCT waits 400ms, the Dashboard 300ms. */
const SETTLE_MS = 400;

async function line(transport, text, timeoutMs = 2000) {
  await transport.tx(ENC.encode(`${text}@`));
  // Give the module time to start answering. Reading immediately and breaking
  // at the first pause was catching the tail of the previous reply instead.
  await sleep(SETTLE_MS);

  const deadline = Date.now() + timeoutMs;
  let acc = '';
  let lastByte = Date.now();
  while (Date.now() < deadline) {
    const d = await transport.rxTimeout(512, Math.max(50, Math.min(150, deadline - Date.now())));
    if (d.length) { acc += DEC.decode(d); lastByte = Date.now(); }
    // AOK / ERR / the <x.xx> prompt all mean the module is done with this line.
    if (/\bAOK\b|\bERR\b|<\d+\.\d+>/i.test(acc) && Date.now() - lastByte > 60) break;
    if (acc && Date.now() - lastByte > 400) break;          // went quiet
  }

  const clean = acc.replace(/[\r\n]+/g, ' ').trim();
  // Strip our own echo so the log shows the ANSWER, not the question again.
  const reply = clean.startsWith(text) ? clean.slice(text.length).trim() : clean;
  return {
    raw: clean,
    reply,
    ok: /\bAOK\b/i.test(clean),
    err: /\bERR\b/i.test(clean),
    silent: clean === '',
    interference: INTERFERENCE.test(clean),
  };
}

/** Re-escape into command mode; returns true once the module answers CMD. */
async function reenterCommandMode(transport) {
  transport.flush();
  await sleep(300);                       // WiFly wants a quiet guard time
  await transport.tx(ENC.encode('$$$'));
  const deadline = Date.now() + 2500;
  let acc = '';
  while (Date.now() < deadline) {
    const d = await transport.rxTimeout(256, 200);
    if (d.length) acc += DEC.decode(d);
    if (/CMD/i.test(acc)) return true;
  }
  return false;
}

/**
 * Send a config line, and if the module was knocked out of command mode by
 * another client's traffic, escape back in and try once more.
 */
async function sendConfig(transport, cmd, log) {
  let r = await line(transport, cmd);
  if (r.ok || r.err) return r;

  if (r.interference || r.silent) {
    log(`  ${cmd} — no usable answer${r.raw ? ` (${r.raw})` : ''}; ` +
        're-entering command mode and retrying…', 't-warn');
    if (await reenterCommandMode(transport)) {
      r = await line(transport, cmd);
      if (r.ok) log('  back in command mode.', 't-dim');
    } else {
      log('  could not get back into command mode.', 't-err');
    }
  }
  return r;
}

/**
 * Run the restore. `transport` must be a serial transport with the port open.
 *
 * Returns { ok, steps, failures }. `failures` lists commands the module
 * answered with ERR — UFCT ignores the replies entirely, but a silent failure
 * on a restore is exactly the thing worth surfacing.
 */
export async function restoreRn131(transport, log = () => {}, onStep = () => {}) {
  const failures = [];
  let step = 0;
  const bump = (what) => { step++; onStep(step, RESTORE_STEP_COUNT, what); };

  log('Entering passthrough and putting the RN-131 into command mode…');
  transport.flush();
  await transport.tx(ENC.encode('ESPw42!'));
  await sleep(400);
  const entered = DEC.decode(await transport.rxTimeout(256, 600)).trim();
  if (entered) log(`  ${entered}`);

  // $$$ is the RN-131's Hayes-style escape. It takes no terminator, and the
  // module wants a quiet period either side of it. It answers "CMD".
  await sleep(300);
  transport.flush();
  await transport.tx(ENC.encode('$$$'));
  let cmdMode = '';
  const escDeadline = Date.now() + 2000;
  while (Date.now() < escDeadline) {
    const d = await transport.rxTimeout(256, 200);
    if (d.length) cmdMode += DEC.decode(d);
    if (/CMD/i.test(cmdMode)) break;
  }
  cmdMode = cmdMode.replace(/[\r\n]+/g, ' ').trim();
  if (/CMD/i.test(cmdMode)) {
    log('  module is in command mode (CMD).', 't-ok');
  } else {
    // Not fatal — carry on and let the per-command replies tell the story —
    // but say so, because every command failing afterwards would otherwise be
    // a mystery rather than an obvious consequence.
    log(`  no CMD from $$$${cmdMode ? ` (got: ${cmdMode})` : ''}. ` +
        'The module may not be in command mode.', 't-warn');
  }

  const silent = [];
  let sawInterference = false;
  try {
    for (const group of RN131_RESTORE_GROUPS) {
      log(`${group.title}…`);
      for (const cmd of group.cmds) {
        const r = await sendConfig(transport, cmd, log);
        bump(cmd);
        if (r.interference) sawInterference = true;
        if (r.err) {
          failures.push({ cmd, reply: r.reply });
          log(`  ${cmd} → ${r.reply}`, 't-err');
        } else if (r.ok) {
          log(`  ${cmd} → ${r.reply || 'AOK'}`, 't-ok');
        } else {
          silent.push(cmd);
          log(`  ${cmd} → not confirmed${r.raw ? ` (${r.raw})` : ''}`, 't-warn');
        }
      }

      const s = await sendConfig(transport, 'save', log);
      bump('save');
      if (s.interference) sawInterference = true;
      if (s.err) {
        failures.push({ cmd: `save (${group.title})`, reply: s.reply });
        log(`  ${group.title} NOT saved → ${s.reply}`, 't-err');
      } else if (/Storing/i.test(s.raw) || s.ok) {
        // The RN-131 answers a save with "Storing in config", not AOK.
        log(`  ${group.title} saved → ${s.reply || 'stored'}`, 't-ok');
      } else {
        silent.push(`save (${group.title})`);
        log(`  ${group.title} — save not confirmed${s.raw ? ` (${s.raw})` : ''}`, 't-warn');
      }
      await sleep(100);
    }

    log('Rebooting the module…');
    await line(transport, 'reboot', 800);
    bump('reboot');
  } finally {
    // Always leave passthrough, whatever happened above — otherwise the mount
    // stays deaf to ES commands until it is power-cycled.
    log('Leaving passthrough (###)…');
    try {
      transport.flush();
      await transport.tx(ENC.encode('###'));
      await sleep(600);
      const bye = DEC.decode(await transport.rxTimeout(256, 600)).trim();
      if (bye) log(`  ${bye}`);
    } catch (e) {
      log(`  could not confirm the passthrough exit: ${e.message}`, 't-err');
    }
  }

  const ok = restoreSucceeded({ failures, silent });
  if (sawInterference) {
    log('Another client was talking to the mount over Wi-Fi during the restore ' +
        '(*OPEN*/*CLOS* and ES commands appeared in the replies). That traffic ' +
        'shares the module and can knock it out of command mode — close the app ' +
        'or PWA connected to the mount and run this again.', 't-err');
  }
  return { ok, steps: step, failures, silent, interference: sawInterference };
}
