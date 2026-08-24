# Third-Party Notices

The Propeller P1 boot-protocol code in `src/p1-protocol.js` and
`src/p1-loader.js` is a JavaScript port of `p1_loader.py` (MIT), which is itself
a derivative of `p1load` by dbetz (MIT). Specifically, the LFSR handshake, the
version read, the 11-byte long encoding and the ACK handling are ported from
`ploader.c`, which is adapted from Chip Gracey's PNut IDE.

**No GPL code is used here, and none should be introduced.** This lineage
deliberately replaced a GPL-2.0 Propeller uploader with the MIT one (see
`PMC8-Dashboard` commit `0c7e985`). In particular, do not lift loader code from
Parallax's BlocklyProp launcher without first confirming its license — it is
unnecessary, since the MIT implementation above is already proven on this
hardware.

The Windows transport notes referenced in `docs/PROTOCOL.md` derive from
`osint_mingw.c` by Steve Denson (MIT).

## p1load

- Upstream: https://github.com/dbetz/p1load
- License: MIT
- Copyright (c) 2015 dbetz

```text
The MIT License (MIT)

Copyright (c) 2015 dbetz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## osint_mingw.c

```text
Copyright (c) 2011 by Steve Denson.

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
