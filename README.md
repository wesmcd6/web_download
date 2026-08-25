# web_download — PMC-Eight browser tools

Talk to a PMC-Eight mount over USB straight from the browser, using the Web
Serial API. No desktop app, no Python, no install.

Two pages:

| Page | Risk | What it does |
|---|---|---|
| `/` (`index.html`) | **permanent** | Updates the Propeller (P1) mount firmware, then reads the version back to prove it took. Diagnostics live under Advanced. |
| `identify.html` | reads freely, writes on request | Reports mount model, both firmware versions and **which Wi-Fi module is fitted**, and lets every stored setting be changed. Works over USB or Wi-Fi. |

This is the **Propeller** — the mount's brain. The ESP32/ESP8266 Wi-Fi module is
a separate processor with its own OTA path, and is out of scope here.

## Status

Protocol port is **complete and golden-vector tested** against the
hardware-proven Python loader — including byte-identical encoding of the real
29,584-byte `20A02.2.0.1.bt` image.

**Phases 0 and 1 PASS on real hardware** (2026-08-24, Windows + Chrome, iEXOS-100).
The DTR reset works from Web Serial, the LFSR seed and taps are correct, and the
handshake completes in 178 ms returning Propeller version 1. Full capture in
[docs/HARDWARE-LOG.md](docs/HARDWARE-LOG.md).

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

51 assertions, no hardware needed: the LFSR, the 11-byte long encoder, the
509-byte handshake, the full payload for a real firmware image, and the
`ESGv!`/`ESGi!` parsers. Regenerate the vectors with
`python test/generate-vectors.py` if `p1_loader.py` ever changes.

## Layout

```
index.html            hub page
identify.html         read-only identify tool
loader.html           staged firmware loader
src/p1-protocol.js    pure protocol — LFSR, encoder, handshake builder
src/p1-serial.js      Web Serial transport (reset, tx, buffered rx)
src/p1-loader.js      loader orchestration + phase 0 listen
src/pmc8-identify.js  ESGv!/ESGi! commands and parsers
test/                 golden vectors + node test runner
docs/DESIGN.md        why, architecture, what is verified vs not
docs/PROTOCOL.md      the wire, in detail — read before touching the loader
docs/FIRMWARE-NOTES.md  firmware-source findings, incl. the do-not-send list
```

## Read these before changing anything

- **`docs/PROTOCOL.md` → "The contiguous-write risk".** The boot ROM aborts on
  inter-byte gaps mid-image and silently falls back to the existing EEPROM
  firmware. Encode before the handshake; one `write()` for the whole image;
  never chunk it.
- **`docs/FIRMWARE-NOTES.md` → "DO NOT SEND".** Several commands that look like
  getters are not. `ESGe!` writes EEPROM. `ESM!` starts a motor. `%%%` disables
  the ES command set.
- **`THIRD_PARTY_NOTICES.md`.** MIT throughout, deliberately. Do not introduce a
  GPL Propeller loader.

## Before this is published anywhere

A web page that loads firmware makes the host a firmware distribution channel.
Settle these first — see `docs/DESIGN.md`:

- versioned immutable URLs, never `latest.bin`
- hash-check the image in the page and show the version before writing
- decide who can publish
- GitHub Pages off the releases repo is safer than a Shopify theme
