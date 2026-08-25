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
 * Send one line through passthrough and collect whatever comes back.
 * The RN-131 answers `AOK` on success and `ERR` on a bad command.
 */
async function line(transport, text, waitMs = 400) {
  transport.flush();
  await transport.tx(ENC.encode(`${text}@`));
  await sleep(waitMs);
  const d = await transport.rxTimeout(512, 200);
  return DEC.decode(d).replace(/[\r\n]+/g, ' ').trim();
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
  // module wants a quiet period either side of it.
  await sleep(300);
  transport.flush();
  await transport.tx(ENC.encode('$$$'));
  await sleep(600);
  const cmdMode = DEC.decode(await transport.rxTimeout(256, 400)).trim();
  log(cmdMode ? `  module says: ${cmdMode}` : '  module said nothing to $$$');

  try {
    for (const group of RN131_RESTORE_GROUPS) {
      log(`${group.title}…`);
      for (const cmd of group.cmds) {
        const reply = await line(transport, cmd);
        bump(cmd);
        if (/ERR/i.test(reply)) {
          failures.push({ cmd, reply });
          log(`  ${cmd} → ${reply}`, 't-err');
        } else {
          log(`  ${cmd}${reply ? ` → ${reply}` : ''}`);
        }
      }
      const saved = await line(transport, 'save');
      bump('save');
      log(`  save${saved ? ` → ${saved}` : ''}`);
      await sleep(100);
    }

    log('Rebooting the module…');
    await line(transport, 'reboot', 200);
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

  return { ok: failures.length === 0, steps: step, failures };
}
