# Benchmark interruption diagnosis

These artifacts are diagnostic evidence, not final benchmark results.

- `invalid-partial-results-34rows.json` is the checkpoint from an interrupted 20-sample attempt. It stopped after 34 rows and must not be used for performance conclusions.
- A one-condition phase-1 probe completed its browser workflow, then exposed a separate baseline-only report-formatting failure. The formatter now has a regression test.
- A single phase-2 replay used the original alternating order for three throttled/cold samples (42 rows). It completed all rows, including the historical next row 35, without reproducing the stall.
- The historical reason for the interruption remains unknown. The successful replay does not establish that instrumentation or timeout changes fixed it.

The harness now treats missing CDP responses, missing page-load events, WebSocket disconnects, and expression waits as bounded failures. A page-load timeout records a bounded same-client page snapshot and connection state, then exits nonzero; it is never treated as a successful sample. Chrome is launched with an isolated temporary profile and cleanup is limited to the process created by the harness.

Raw phase traces and console logs remain local under `/tmp/pdfart-phase-diagnostics-20261017/`. The corresponding issue comments are:

- Phase 1 start/result: https://github.com/NyongCho/pdfart/issues/1#issuecomment-6233975264 and https://github.com/NyongCho/pdfart/issues/1#issuecomment-6233981358
- Phase 2 start/result: https://github.com/NyongCho/pdfart/issues/1#issuecomment-6234002008 and https://github.com/NyongCho/pdfart/issues/1#issuecomment-6234044709

## Interrupted final run

`interrupted-20261017-460rows.json` is the read-only checkpoint from the final run interrupted by a host `SYSTEMSUSPEND` event. Its 280 complete cold-cache rows are included in the final result; all 180 warm-cache rows are excluded. A separate sleep-inhibited session supplied all 280 warm-cache rows. The final JSON records both source hashes and inclusion counts, and the final report describes the two-session composition and exact commands.
