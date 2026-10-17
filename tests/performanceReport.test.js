import assert from 'node:assert/strict';
import { it } from 'node:test';
import { formatReport } from '../scripts/performance/benchmark.mjs';

it('formats a baseline-only diagnostic result without requiring candidate metrics', () => {
    const report = formatReport({
        metadata: {
            baselineSha: 'baseline-sha',
            candidateSha: 'candidate-sha',
            node: 'node-test',
            chrome: 'chrome-test',
            samples: 1,
            fixtures: { small: { pages: 2 }, large: { pages: 20 } },
            assetSha256: { baseline: { 'assets/index.js': 'abc123' }, candidate: {} },
        },
        summary: [{
            variant: 'baseline',
            profile: 'throttled',
            cache: 'cold',
            scenario: 'split-large',
            metrics: { downloadMs: { median: 237.9, p95: 237.9, unit: 'ms' } },
        }],
    });

    assert.match(report, /\| throttled \| cold \| split-large \| downloadMs \| 237\.90 \| 237\.90 \| n\/a \| n\/a \| n\/a \| ms \|/);
});
