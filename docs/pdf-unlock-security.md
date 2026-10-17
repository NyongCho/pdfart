# PDF unlock engine and security record

Review date: 2026-10-18

## Pinned runtime

PDFart uses `@wasm-zoo/qpdf` **exactly 0.1.1** only for its published asset
URLs. It does not call the package's browser runner. An application-owned,
one-shot classic Worker loads the raw generated core and invokes QPDF with
fixed virtual paths and these transform options:

`--stream-data=preserve --decode-level=none --decrypt`

The dependency gate is enforced by `npm run verify:engine`:

- npm SRI: `sha512-smxfhQPwUYJtvfze69TXyYK4otc9femdxf+jxTf7seuuAbbbYsbVSftK9vL1m2Xfgk6PwmZmWdvlbyyz5fzfOA==`
- `qpdf-core.js` SHA-256: `0ead3c7e15498a0af4a59008952d9e59cee847733b612eb3b25da6957ee05138`
- `qpdf-core.wasm` SHA-256: `07ced6845a714be265c4e6c5a9515e1746cc71c7f193f357b912b9f74c53b50d`

Any package or core hash change reopens dependency, runtime, fixture, license,
and vulnerability review. The generated `createQpdfCore`/`FS`/`callMain`
surface is a private, pinned integration contract rather than a semver-stable
consumer API.

## Native component inventory

| Component | Pinned version / source |
| --- | --- |
| QPDF | 12.4.2, <https://github.com/qpdf/qpdf/releases/tag/v12.4.2> |
| zlib | 1.3.2, Emscripten port recorded in the publisher provenance |
| libjpeg | **9f**; this corrects the publisher SBOM's erroneous `6.0.8` version label |
| Emscripten | 6.0.8 |
| WASM Zoo package | 0.1.1, attested publish commit `186bdf2ecfd40009f838a0ac89830937af093100` |

The publisher records source/build provenance, but PDFart did **not** perform
an independent source-to-binary reproducible rebuild. The release tag is not
a substitute for an independently reproduced binary.

## Notices

The exact package notices and provenance artifacts are served under
[`/third-party/qpdf/`](../public/third-party/qpdf/). This includes the WASM Zoo
MIT license, QPDF Apache License 2.0 text and NOTICE, zlib notice, IJG
libjpeg notice, build information, manifest, provenance, and the publisher
SBOM. CI verifies that these copies remain byte-identical to the pinned npm
package.

## Controls and residual limits

- Maximum input: 50 MiB. This is an input policy, not a RAM guarantee.
- Whole-operation deadline: 60 seconds, including facade import, file read,
  core load, and processing.
- One active operation; cancel, file replacement, and mode change terminate
  the one-shot Worker and discard late messages/downloads.
- Only unlock exit status `0` is downloadable. Warnings (`3`), errors,
  timeout, and cancellation discard any output. The special
  `--requires-password` status is interpreted separately.
- Worker-local stdout/stderr collection is capped at 4 KiB, used only for
  fixed error classification, and never returned to the UI or console.
- No `--check`, linearization, image optimization, server fallback,
  rasterization, password guessing, or network upload path is used.
- The published module can grow WebAssembly linear memory to 512 MiB. This is
  not a total browser-process limit; input/output/JS/browser allocations are
  additional. A browser Worker limits UI impact but is not a hard memory
  sandbox.
- Rewriting may invalidate existing digital signatures and is not malware
  sanitization.

## Advisory exception register

Reviewed 2026-10-18. Re-review on every engine upgrade.

- QPDF issue [#1688](https://github.com/qpdf/qpdf/issues/1688): decompression
  can cause substantial resource growth. Mitigations are file/deadline limits,
  one-shot Worker termination, and avoiding unrelated transformations; these
  do not prove a total-memory ceiling.
- QPDF issue [#1739](https://github.com/qpdf/qpdf/issues/1739): resource use in
  linearization-check paths. Those diagnostic paths are not called.
- zlib CVE-2026-76844 and CVE-2026-85091 concern `gz*` write APIs after write
  failure. No `gzwrite`, `gzprintf`, `gzvprintf`, or `gzclearerr` call path was
  found in the pinned QPDF source; PDFart invokes QPDF's inflate/deflate path.
  This is a reachability exception, **not** a claim that all native
  dependencies are vulnerability-free. Sources:
  <https://nvd.nist.gov/vuln/detail/CVE-2026-76844> and
  <https://nvd.nist.gov/vuln/detail/CVE-2026-85091>.

## Tested compatibility

Production Vite builds were exercised in desktop Chrome with synthetic public
fixtures for AES-128 R4, AES-256 R5/R6, RC4-128 R3, RC4-40 R2, and an exact
leading/trailing-space Korean/emoji password. Output was opened without a
password by independent `pdf-lib` and compared against the plaintext source's
PDF.js text, annotations, outline, attachment, metadata, complete render
operator sequence, and rendered PNG pixel hash at the same viewport. This is
not a universal browser or Unicode-normalization
guarantee. Firefox and Safari have not been verified for this feature.

### Representative product-build measurement

Measured again on 2026-10-18 through the current production Vite UI in local
desktop Chrome (not reused from the engine probe): a reproducible 12,589,949
byte encrypted input produced a 12,588,843 byte output in 256.4 ms on the
first run and 231.5 ms on the repeat run. The emitted core assets were 62,933
bytes of JS and 2,196,333 bytes of WASM. These are representative observations
from one machine, not p95 guarantees or a cancellation-latency benchmark.

Password input is a single-line browser control. Leading/trailing spaces are
preserved. NUL is rejected because the native C-string interface cannot
represent it. Pasted/inserted line breaks are rejected instead of silently
using only part of a password. The app does not normalize or guess passwords.
