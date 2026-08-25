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
async function line(transport, text, timeoutMs = 2000) {
  await transport.tx(ENC.encode(`${text}@`));

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
  };
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
  try {
    for (const group of RN131_RESTORE_GROUPS) {
      log(`${group.title}…`);
      for (const cmd of group.cmds) {
        const r = await line(transport, cmd);
        bump(cmd);
        if (r.err) {
          failures.push({ cmd, reply: r.reply });
          log(`  ${cmd} → ${r.reply}`, 't-err');
        } else if (r.silent) {
          silent.push(cmd);
          log(`  ${cmd} → no reply`, 't-warn');
        } else {
          log(`  ${cmd} → ${r.reply || 'OK'}`, 't-ok');
        }
      }

      const s = await line(transport, 'save');
      bump('save');
      if (s.err) {
        failures.push({ cmd: `save (${group.title})`, reply: s.reply });
        log(`  ${group.title} NOT saved → ${s.reply}`, 't-err');
      } else if (s.silent) {
        silent.push(`save (${group.title})`);
        log(`  ${group.title} — save sent, no confirmation`, 't-warn');
      } else {
        log(`  ${group.title} saved → ${s.reply || 'OK'}`, 't-ok');
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

  return { ok: failures.length === 0, steps: step, failures, silent };
}
