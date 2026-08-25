# web_download — PMC-Eight browser tools

Talk to a PMC-Eight mount over USB straight from the browser, using the Web
Serial API. No desktop app, no Python, no install.

Two pages:

One page, four collapsible tools, sharing a single open connection — so the port
is opened once and the mount is reset once, not per tool.

| Section | Risk | What it does |
|---|---|---|
| **Connect** | none | USB or Wi-Fi. Proves the link with `ESGv!` before calling it connected. |
| **Get and change settings** | reads freely, writes on request | Mount model, both firmware versions, **which Wi-Fi module is fitted**, and every stored setting, editable. Reopening shows the last read. |
| **Firmware upload** | **permanent** | Updates the Propeller (P1) firmware and reads the version back to prove it took. **USB only.** |
| **Command console** | up to **permanent** | Any ES command, with the risk named. Sends without confirming. |

`identify.html` and `loader.html` are redirect stubs for old bookmarks.

This is the **Propeller** — the mount's brain. The ESP32/ESP8266 Wi-Fi module is
a separate processor with its own OTA path, and is out of scope here.

## Status

Protocol port is **complete and golden-vector tested** against the
hardware-proven Python loader — including byte-identical encoding of the real
29,584-byte `20A02.2.0.1.bt` image.

**Verified on real hardware** (Windows + Chrome, iEXOS-100). The DTR reset works
from Web Serial, the LFSR seed and taps are correct, and the handshake returns
Propeller version 1 in 178 ms.

**✅ Firmware loading is verified on hardware.** An old version was loaded, then
a new one, and the reported version changed — which also settles the one thing
that could not be settled by reading code: Chrome streams a single ~81 KB
`write()` contiguously enough for the boot ROM.

Settings read and write are confirmed over USB, and over Wi-Fi as well. The only
thing Wi-Fi cannot do is `AT+GMR`, which needs passthrough.

## Run it

Web Serial needs a secure context, so `file://` will not work. Serve over
`http://localhost`:

```sh
python -m http.server 8000
# then open http://localhost:8000/
```

Requires **desktop Chrome, Edge or Opera**. Firefox, Safari, iOS and Android
Chrome have no Web Serial API. Close UFCT and the PMC8 Dashboard first —
Windows will not share the COM port.

## Test

```sh
node test/run-tests.mjs
```

192 assertions, no hardware needed: the LFSR, the 11-byte long encoder, the
509-byte handshake, the full payload for a real firmware image, the
`ESGv!`/`ESGi!`/`ESGe!`/`AT+GMR` parsers, the `ESSi!` builder, the command
table, and the RN-131 restore sequence. Regenerate the protocol vectors with
`python test/generate-vectors.py` if `p1_loader.py` ever changes.

```sh
node test/compare-ufct.mjs [path-to-Form1.Wifi.vb]
```

Re-derives the RN-131 restore sequence from UFCT's VB source and diffs it
against ours, segment boundaries included. Kept out of the main run because it
needs the UFCT checkout.

## Layout

```
index.html            the whole app — six collapsible tools
identify.html         redirect stub (old bookmarks)
loader.html           redirect stub (old bookmarks)
src/p1-protocol.js    pure protocol — LFSR, encoder, handshake builder
src/p1-serial.js      Web Serial transport (reset, tx, buffered rx)
src/p1-loader.js      loader orchestration + reset-and-listen
src/pmc8-identify.js  ESGv!/ESGi!/ESGe! commands and parsers
src/pmc8-settings.js  ESSi! builder + write/verify
src/pmc8-commands.js  the ES command table
src/pmc8-network.js   home-network join and address read
src/pmc8-rn131.js     RN-131 factory restore
src/mount-link.js     one send(command) interface over USB or Wi-Fi
test/                 golden vectors + node test runner
docs/PROTOCOL.md      the wire, in detail — read before touching the loader
```

## Read this before changing anything

**`docs/PROTOCOL.md` → "The contiguous-write risk".** The boot ROM aborts on
inter-byte gaps mid-image and silently falls back to the existing EEPROM
firmware. Encode before the handshake; one `write()` for the whole image; never
chunk it.

**`THIRD_PARTY_NOTICES.md`.** MIT throughout, deliberately. Do not introduce a
GPL Propeller loader.

Several ES commands that look like getters are not — some write EEPROM, one
starts a motor, and `%%%` disables the ES command set entirely. The command
console labels each one; do not send anything from it that you have not checked.

## Hosting

A page that loads firmware makes its host a firmware distribution channel.
Settle these before pointing anyone at a deployment:

- versioned immutable URLs, never `latest.bin`
- hash-check the image in the page and show the version before writing
- decide who can publish

Note the two transports want opposite things from the origin: **Web Serial
requires HTTPS**, and reaching a plain-HTTP mount requires the page **not** be
HTTPS. A hosted copy can do USB; Wi-Fi needs the page served over `http://` on
the same network.
