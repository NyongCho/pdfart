# PDF performance benchmark

The benchmark compares two already-built production directories through the same loopback HTTP server and the same installed Chrome runtime. It adds no benchmark dependencies. Chrome runs in a new temporary user-data directory that is deleted on exit.

```bash
node scripts/performance/benchmark.mjs \
  --baseline /absolute/path/to/baseline-dist \
  --candidate /absolute/path/to/candidate-dist \
  --baseline-sha BASELINE_SHA \
  --candidate-sha CANDIDATE_SHA \
  --samples 20 \
  --profiles local,throttled \
  --output performance/results.json
```

For a quick harness smoke test, limit the sample, profile, and scenarios:

```bash
node scripts/performance/benchmark.mjs \
  --baseline /absolute/path/to/baseline-dist \
  --candidate /absolute/path/to/candidate-dist \
  --samples 1 \
  --profiles local \
  --scenarios initial,preview-small,merge-small,split-small \
  --output /tmp/pdfart-smoke.json
```

## Measurements

- Initial navigation: FCP, LCP, gzip-encoded JavaScript transfer bytes (Chrome `encodedDataLength`, including protocol overhead), and Chrome main-thread task time. `TaskDuration` is a cumulative inspector-agent counter, so every initial sample uses a fresh target opened on a same-origin blank document, enables Performance, then subtracts the immediately preceding counter value across the same-origin app navigation. Targets share the isolated benchmark profile/cache, while the fresh agent gives each sample an independent counter scope. A counter discontinuity or invalid/missing paint/CPU value stops the run rather than entering the summary. This follows the [Chromium inspector implementation](https://chromium.googlesource.com/chromium/src/+/2210090be8b960f97182327952e0fd4efee2c8b2/third_party/blink/renderer/core/inspector/inspector_performance_agent.cc#178).
- First upload: time to the first thumbnail and all rendered page previews for synthetic 2-page and 20-page PDFs. Each milestone requires the expected images to be complete with non-zero natural width, awaits `decode()`, then crosses a two-`requestAnimationFrame` paint boundary. The current renderer publishes its page image array as one batch rather than progressively, so “first” is a first-image paint milestone within that batch, not a claim of progressive preview delivery.
- First merge/split action: click to completed browser download for small and large synthetic PDFs.
- Cache: every cold sample disables and clears the browser cache; every warm sample primes the exact scenario before measuring it.
- Profiles: unthrottled local execution and a documented simulated throttled network/CPU profile. Both are delivered from the same local Node server, which applies gzip equally to baseline and candidate text assets; neither result should be generalized to Vercel edge latency.

The JSON file contains every raw sample plus median/p95 summaries. The adjacent Markdown report is generated from those raw values. Results are checkpointed after every sample so an interrupted run retains its completed raw data.

## Reproducibility rules

Build baseline and candidate with the same Node/npm versions, lockfile, and environment. Do not run builds or other CPU-heavy tasks during final measurements. Record exact SHAs. Bundle-size changes are supporting evidence only; assess initial metrics together with the deferred first-use latency.
