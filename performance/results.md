# PDF lazy-loading performance results

- Baseline: `0a52317159ecd2d90dc797ae3bb7de486a37e764`
- Candidate: `0acf4ba2795864563646a7bd113ac01cef01ec53`
- Runtime: v24.15.0; Google Chrome 155.0.8059.84
- Samples: 20 per variant/profile/cache/scenario
- Percentiles: nearest-rank (ceil(N × p), one-based)
- Delivery: local built-in HTTP server with gzip for text assets. JavaScript bytes are Chrome encoded transfer bytes (including protocol overhead). The `throttled` profile uses 40 ms latency, 200000 B/s download, 93750 B/s upload, and 4x CPU throttling.

## Executive interpretation

On the throttled cold-cache profile, deferring the PDF engines reduced median initial FCP and LCP from 2,696 ms to 1,080 ms (-59.9%), JavaScript transfer from 365,338 bytes to 67,872 bytes (-81.4%), and measured main-thread task time from 730.74 ms to 687.14 ms (-6.0%). With a warm cache, median initial FCP/LCP fell from 280 ms to 180 ms (-35.7%) and main-thread task time from 249.90 ms to 175.91 ms (-29.6%); both variants transferred zero JavaScript bytes from the network in that condition.

The improvement is not free: the deferred engine is paid for on the first corresponding PDF action. Cold-cache preview medians increased by 13.7%–25.3%, while merge/split download medians increased by roughly 0.98–1.02 seconds (649.6%–1,077.1%). Warm-cache preview medians increased by 1.9%–19.1%, and merge/split medians increased by 31.0–31.7 ms (66.2%–130.1%). The result is therefore a startup-first tradeoff: substantially faster initial rendering and less initial JavaScript transfer, with an honest first-use latency penalty when previewing, merging, or splitting a PDF.


| Profile | Cache | Scenario | Metric | Before median | Before p95 | After median | After p95 | Median delta | Unit |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| throttled | cold | initial | fcpMs | 2696.00 | 3052.00 | 1080.00 | 1224.00 | -59.9% | ms |
| throttled | cold | initial | lcpMs | 2696.00 | 3052.00 | 1080.00 | 1224.00 | -59.9% | ms |
| throttled | cold | initial | jsTransferBytes | 365338.00 | 365338.00 | 67872.00 | 67872.00 | -81.4% | bytes |
| throttled | cold | initial | mainThreadTaskMs | 730.74 | 1119.14 | 687.14 | 850.90 | -6.0% | ms |
| throttled | cold | preview-small | firstThumbnailMs | 2423.20 | 2588.30 | 3036.60 | 3240.60 | 25.3% | ms |
| throttled | cold | preview-small | allPreviewsMs | 2473.70 | 2637.90 | 3086.90 | 3290.60 | 24.8% | ms |
| throttled | cold | preview-large | firstThumbnailMs | 3556.00 | 4047.10 | 4047.70 | 4697.60 | 13.8% | ms |
| throttled | cold | preview-large | allPreviewsMs | 3605.00 | 4097.20 | 4098.40 | 4747.30 | 13.7% | ms |
| throttled | cold | merge-small | downloadMs | 110.70 | 166.10 | 1118.30 | 1191.00 | 910.2% | ms |
| throttled | cold | merge-large | downloadMs | 157.40 | 277.10 | 1179.80 | 1381.80 | 649.6% | ms |
| throttled | cold | split-small | downloadMs | 91.00 | 129.30 | 1071.20 | 1113.60 | 1077.1% | ms |
| throttled | cold | split-large | downloadMs | 112.80 | 235.10 | 1102.00 | 1231.20 | 877.0% | ms |
| throttled | warm | initial | fcpMs | 280.00 | 312.00 | 180.00 | 212.00 | -35.7% | ms |
| throttled | warm | initial | lcpMs | 280.00 | 312.00 | 180.00 | 212.00 | -35.7% | ms |
| throttled | warm | initial | jsTransferBytes | 0.00 | 0.00 | 0.00 | 0.00 | n/a | bytes |
| throttled | warm | initial | mainThreadTaskMs | 249.90 | 289.26 | 175.91 | 211.41 | -29.6% | ms |
| throttled | warm | preview-small | firstThumbnailMs | 138.90 | 155.70 | 165.40 | 186.80 | 19.1% | ms |
| throttled | warm | preview-small | allPreviewsMs | 188.80 | 205.20 | 215.00 | 237.00 | 13.9% | ms |
| throttled | warm | preview-large | firstThumbnailMs | 473.30 | 522.40 | 483.30 | 555.20 | 2.1% | ms |
| throttled | warm | preview-large | allPreviewsMs | 522.90 | 572.20 | 533.00 | 604.60 | 1.9% | ms |
| throttled | warm | merge-small | downloadMs | 26.80 | 41.60 | 57.80 | 78.10 | 115.7% | ms |
| throttled | warm | merge-large | downloadMs | 47.10 | 58.00 | 78.30 | 99.10 | 66.2% | ms |
| throttled | warm | split-small | downloadMs | 23.90 | 30.60 | 55.00 | 71.50 | 130.1% | ms |
| throttled | warm | split-large | downloadMs | 34.80 | 46.90 | 66.50 | 78.40 | 91.1% | ms |

## Production asset SHA-256

| Variant | Asset | SHA-256 |
| --- | --- | --- |
| baseline | `assets/index-CShGAY7A.js` | `1c643e826462438dd48e53b19fbbc1ca1bab450d148b303778bae5b3852fc30e` |
| baseline | `assets/index-Ctt6BMMc.css` | `739127928940279c6b7691c572d2177a38db98a164a076c09ee69d658fa6b24b` |
| baseline | `assets/pdf.worker-DjmdXq8j.mjs` | `77db27489c126d5c6d7f2e88e7d98543edf1a6c61b4fae5a628493cd342f9782` |
| baseline | `favicon.svg` | `51aa23a9c1beec7394bc216f3110aaac55cc2dabb8a8d5fe03afa629eb26f42d` |
| baseline | `index.html` | `9bc8d600ab5666fa2fd7d1294c5d9dcc2b2b2bf2e071fc491e6d3ea49414976c` |
| baseline | `og-image.png` | `f419afc12d916dcdb3d0513d1694e6c78fb3d34fa3cfe07652363e8b7ddb2194` |
| baseline | `vite.svg` | `4a748afd443918bb16591c834c401dae33e87861ab5dbad0811c3a3b4a9214fb` |
| candidate | `assets/index-B-NoyiRU.css` | `6bafb009d019780d76ca2b9c18e659a9c8ded4c90449549b222e68a5542e39a4` |
| candidate | `assets/index-DhRtUWcz.js` | `fe0cdeda48827805e0b5c24fd4e8def149e028d64e3622f8f1423c14f84abe98` |
| candidate | `assets/pdf.worker-DjmdXq8j.mjs` | `77db27489c126d5c6d7f2e88e7d98543edf1a6c61b4fae5a628493cd342f9782` |
| candidate | `assets/pdfManager-vylqxAXA.js` | `fefc6d31e51825e0e8a96eb8741598bddd215522e0d67cee232af8f7952f47b5` |
| candidate | `assets/pdfRenderer-DgCgN1aI.js` | `c28ec8f25faf720f7268bdd08e2e34e3b39305cc85dca969afbc5bb4b6df72ef` |
| candidate | `favicon.svg` | `51aa23a9c1beec7394bc216f3110aaac55cc2dabb8a8d5fe03afa629eb26f42d` |
| candidate | `index.html` | `40c1cb9d87bc1f29b0e9b915e632e76eaaa43db28d69f4f9b02df5810647f0dd` |
| candidate | `og-image.png` | `f419afc12d916dcdb3d0513d1694e6c78fb3d34fa3cfe07652363e8b7ddb2194` |
| candidate | `vite.svg` | `4a748afd443918bb16591c834c401dae33e87861ab5dbad0811c3a3b4a9214fb` |

## Limits

- Chrome throttling is simulated and does not represent every device or network.
- Runs use synthetic PDFs (2 and 20 pages) and a loopback server; real documents vary.
- Download completion includes browser download handling. Preview milestones are observed from rendered DOM images.
- CDP round trips, polling, decode, download observation, and animation-frame boundaries add shared measurement overhead; sub-frame differences should not be overinterpreted.
- Bundle transfer changes alone are not treated as proof of user-visible improvement; first-use action latency is reported alongside initial rendering.

## Measurement provenance

This report combines two completed cache-condition segments, not one uninterrupted process: all 280 cold rows come from the interrupted session, and all 280 warm rows come from the later sleep-inhibited recovery session. The interrupted session's 180 warm rows were discarded as a whole; no individual warm sample was selected. Source paths, timestamps, SHA-256 values, and included/excluded row counts are recorded in the JSON metadata.

The interruption coincided with a host `SYSTEMSUSPEND` event and closed the CDP WebSocket. This environmental diagnosis does not change any measured value.

### Exact source commands

```bash
# Original session; only its complete cold segment is included.
timeout --signal=TERM --kill-after=5s 4500s node scripts/performance/benchmark.mjs --baseline /tmp/pdfart-final-bench-HWrSYP/baseline-dist --candidate /tmp/pdfart-final-bench-HWrSYP/candidate-dist --output performance/results.json --samples 20 --profiles throttled --caches cold,warm --variants baseline,candidate --scenarios initial,preview-small,preview-large,merge-small,merge-large,split-small,split-large --baseline-sha 0a52317159ecd2d90dc797ae3bb7de486a37e764 --candidate-sha 0acf4ba2795864563646a7bd113ac01cef01ec53 --diagnostic-log /tmp/pdfart-final-560-0acf4ba-20261017T221352.jsonl

# Recovery session; all warm rows are included.
systemd-inhibit --what=idle:sleep --mode=block-weak --no-ask-password --who='PDFart benchmark' --why='Bounded comparison; released when command exits' timeout --signal=TERM --kill-after=5s 2400s node scripts/performance/benchmark.mjs --baseline /tmp/pdfart-final-bench-HWrSYP/baseline-dist --candidate /tmp/pdfart-final-bench-HWrSYP/candidate-dist --output /tmp/pdfart-recovery-warm-280-0acf4ba-20261017T234200.json --samples 20 --profiles throttled --caches warm --variants baseline,candidate --scenarios initial,preview-small,preview-large,merge-small,merge-large,split-small,split-large --baseline-sha 0a52317159ecd2d90dc797ae3bb7de486a37e764 --candidate-sha 0acf4ba2795864563646a7bd113ac01cef01ec53 --diagnostic-log /tmp/pdfart-recovery-warm-280-0acf4ba-20261017T234200.jsonl
```
