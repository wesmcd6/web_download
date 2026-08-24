# Propeller P1 boot protocol — the wire

Every constant here is taken from `p1_loader.py`, which is hardware-proven and
derived from `p1load`'s `ploader.c` (MIT). The JS in `src/p1-protocol.js` is a
byte-for-byte port, verified by `test/run-tests.mjs` against golden vectors
captured from the Python — including the real 29,584-byte
`20A02.2.0.1.bt.binary` image.

## Link settings

Fixed **115200 8N1, no flow control.** The P1 ROM loader self-calibrates from
the start bit, so this is an ordinary byte-stream protocol, not bit-banged
timing. That is what makes it browser-friendly: the whole handshake and the
whole program can be precomputed into one `Uint8Array` and issued as a single
`write()`.

Note 8N1 is an external fact — it is inside the assembled serial driver, not an
explicit constant in the firmware source.

## Reset

| | |
|---|---|
| Line | **DTR** |
| Assert | `dataTerminalReady: true` → reset held |
| Pulse width | **25 ms** |
| Settle after release | **90 ms** |
| Then | discard buffered input (`flush()`; Win32 does `PurgeComm`) |

Chrome maps `setSignals({dataTerminalReady: true})` onto the same OS call
(`EscapeCommFunction(SETDTR)`) that the Python loader uses, so the polarity is
not a guess.

## Handshake — one 509-byte write

```
  1 byte    0xF9                  calibration
250 bytes   0xFE | bit            LFSR output, seed 0x50 ('P')
258 bytes   0xF9                  timing: clocks out 250 echo bits + 8 version bits
```

LFSR — taps 7, 5, 4, 1; maximal length, **period 255** (correct, not a bug):

```js
result = lfsr & 1;
lfsr = ((lfsr << 1) & 0xFE) | (((lfsr>>7) ^ (lfsr>>5) ^ (lfsr>>4) ^ (lfsr>>1)) & 1);
```

The chip echoes 250 bytes of `0xFE | bit` matching the **next** 250 iterations
of the same running LFSR — not a re-seeded one. Then 8 bytes whose bit 0 gives
the version, LSB first:

```js
version = ((version >> 1) & 0x7F) | (bit << 7);   // P1 == 1
```

**Reading response bits:** only `0xFE` and `0xFF` are valid. Any other byte is
skipped rather than treated as an error. This is also what makes the handshake
tolerant of leading junk from a mount that was mid-sentence when reset — no
separate alignment search is needed. Timeouts: 100 ms per response bit, 50 ms
per version bit.

## Program download

```
encodeLong(command)      11 bytes
encodeLong(longCount)    11 bytes
encodeLong(word) × N     11 bytes each, little-endian 32-bit words
```

Commands: `0` shutdown · `1` RAM + run · `2` RAM + EEPROM · `3` RAM + EEPROM + run.

Long encoding — 3 bits per byte, low bits first, `0x60` on the final byte:

```js
for (i = 0; i < 11; i++) {
  flag = (i === 10) ? 0x60 : 0;
  out[i] = (0x92 | flag | (x & 1) | ((x & 2) << 2) | ((x & 4) << 4)) & 0xff;
  x >>>= 3;
}
```

Sanity: `encodeLong(0)` → `92929292929292929292f2`;
`encodeLong(0xFFFFFFFF)` → `dbdbdbdbdbdbdbdbdbdbfb`.

Guards: image must be non-empty, a multiple of 4 bytes, and ≤ 32768 bytes.

**Sizing, real numbers.** `20A02.2.0.1.bt.binary` is 29,584 bytes = 7,396 longs
→ 81,378 encoded bytes → ~7.1 s at 115200. Plus the EEPROM burn: call it
15–30 s wall clock.

## Acknowledgements

After the payload, poll: sleep 20 ms → send one `0xF9` → read 1 byte with a
25 ms timeout. `0xFE` = ACK, any other byte = NAK, no byte = retry.

| Stage | Budget | Retries |
|---|---|---|
| Checksum / RAM load | 10000 ms | 400 |
| EEPROM program | 5000 ms | 200 |
| EEPROM verify | 2000 ms | 80 |

The checksum budget is large because it spans the whole program-load time.

## The contiguous-write risk

This is the single most important operational detail, and the only genuinely
open question in the port.

`p1_loader.py` opens the port with **raw Win32 calls instead of pyserial**, and
says why (`p1_loader.py:19-24`):

> the program image must be transmitted as one contiguous stream. pyserial on
> Windows uses overlapped `WriteFile`, which leaves inter-byte gaps mid-image
> that trip the boot ROM's download timeout (it then aborts and boots from
> EEPROM).

So the boot ROM enforces an inter-byte timeout during download, and a stall
mid-image is not a slow success — it is a silent abort that falls back to the
existing EEPROM firmware.

Consequences for this port:

1. **Encode before the handshake, never during it.** `P1Loader.load()` builds
   the entire payload as its first act. Encoding 7,000+ longs mid-stream would
   blow the timeout.
2. **One `write()` for the whole image.** Never chunk it in a loop.
3. **Whether Chrome's serial service preserves contiguity is untested.** It
   buffers on the browser-process side and streams to the OS, which should be
   fine — but "should" is doing work in that sentence. If Phase 2 transfers the
   whole image and then never ACKs, this is the first suspect, not the encoder:
   the encoder is already proven byte-identical to the Python.

## If the handshake fails

Work down this list in order.

1. **No bytes at all.** Run Phase 0. Normal firmware prints a boot splash, so
   silence means wrong reset line/polarity, wrong baud, or the port is held by
   UFCT / the Dashboard / another tab.
2. **Bytes come back but do not match.** Suspect polarity and timings. The
   encoder is golden-vector tested, so it is not the encoder.
3. **Garbage rather than silence in Phase 0.** Wrong baud. `ESSi!` can leave a
   mount booting at 9600–57600; the six legal rates are 9600, 14400, 19200,
   38400, 57600, 115200.
4. **Timeout partway through the 250 echo bits.** A stall in the response
   stream — the settle delay may be too short, so the chip was still booting.
