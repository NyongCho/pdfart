import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';
import { PDFDocument } from 'pdf-lib';
import { mergePdfs, splitPdf } from '../src/utils/pdfManager.js';

// Distinct page widths identify the source pages after a real PDF round trip.
const createPdfFile = async (widths) => {
    const pdf = await PDFDocument.create();
    widths.forEach(width => pdf.addPage([width, 200]));
    return new File([await pdf.save()], 'input.pdf', { type: 'application/pdf' });
};

const readPageWidths = async (bytes) => {
    const pdf = await PDFDocument.load(bytes);
    return pdf.getPages().map(page => page.getWidth());
};

describe('mergePdfs', () => {
    it('preserves every page in file and page order', async () => {
        const first = await createPdfFile([101, 102]);
        const second = await createPdfFile([201, 202, 203]);

        const result = await mergePdfs([first, second]);

        assert.deepEqual(await readPageWidths(result), [101, 102, 201, 202, 203]);
    });

    it('honors a reordered file list', async () => {
        const first = await createPdfFile([101, 102]);
        const second = await createPdfFile([201]);

        const result = await mergePdfs([second, first]);

        assert.deepEqual(await readPageWidths(result), [201, 101, 102]);
    });

    it('can copy a single PDF without losing pages', async () => {
        const file = await createPdfFile([101, 102]);

        assert.deepEqual(await readPageWidths(await mergePdfs([file])), [101, 102]);
    });

    it('does not modify the input file bytes', async () => {
        const file = await createPdfFile([101, 102]);
        const original = await file.arrayBuffer();

        await mergePdfs([file, file]);

        assert.deepEqual(await file.arrayBuffer(), original);
    });

    it('rejects an unreadable PDF instead of silently skipping it', async () => {
        const valid = await createPdfFile([101]);
        const invalid = new File(['not a PDF'], 'invalid.pdf');

        await assert.rejects(mergePdfs([valid, invalid]));
    });
});

describe('splitPdf', () => {
    const selections = [
        { name: 'extracts one page using one-based numbering', range: '2', expected: [102] },
        { name: 'accepts whitespace and comma-separated pages', range: ' 1, 3 , 5 ', expected: [101, 103, 105] },
        { name: 'includes both endpoints of a range', range: '2 - 4', expected: [102, 103, 104] },
        { name: 'deduplicates overlapping selections in source page order', range: '5, 2-4, 3, 1-2', expected: [101, 102, 103, 104, 105] },
        { name: 'clips ranges to the available pages', range: '0-2, 4-9', expected: [101, 102, 104, 105] },
        { name: 'ignores invalid tokens when valid pages remain', range: 'abc, 0, 99, , 3', expected: [103] },
    ];

    for (const { name, range, expected } of selections) {
        it(name, async () => {
            const file = await createPdfFile([101, 102, 103, 104, 105]);

            assert.deepEqual(await readPageWidths(await splitPdf(file, range)), expected);
        });
    }

    for (const range of ['', '   ', '0, 6', '4-2', 'abc']) {
        it(`rejects a selection with no valid pages: ${JSON.stringify(range)}`, async () => {
            const file = await createPdfFile([101, 102, 103, 104, 105]);

            await assert.rejects(splitPdf(file, range), /유효한 페이지 번호가 없습니다/);
        });
    }

    it('does not modify the source PDF', async () => {
        const file = await createPdfFile([101, 102, 103]);
        const original = await file.arrayBuffer();

        await splitPdf(file, '2');

        assert.deepEqual(await file.arrayBuffer(), original);
    });

    it('rejects an unreadable source PDF', async () => {
        await assert.rejects(splitPdf(new File(['not a PDF'], 'invalid.pdf'), '1'));
    });

    // These must not select unintended pages or poison an otherwise valid selection.
    for (const token of ['2.5', '1.5-3.5', '1-2-4', '-2', '0x2', '2e0']) {
        it(`ignores a malformed page token: ${token}`, async () => {
            const file = await createPdfFile([101, 102, 103, 104, 105]);

            assert.deepEqual(await readPageWidths(await splitPdf(file, `${token}, 5`)), [105]);
        });
    }

    const largeRanges = [
        { range: '1-9007199254740991', expected: [101, 102, 103, 104, 105] },
        { range: '9007199254740992-9007199254740992, 1', expected: [101] },
    ];

    for (const { range, expected } of largeRanges) {
        it(`bounds work for a very large page range: ${range}`, async (t) => {
            const file = await createPdfFile([101, 102, 103, 104, 105]);
            // Isolate runaway loops so a regression cannot hang or exhaust the test runner.
            const worker = new Worker(new URL('./helpers/splitPdfWorker.js', import.meta.url), {
                workerData: { bytes: await file.arrayBuffer(), range },
                resourceLimits: { maxOldGenerationSizeMb: 64 },
            });
            t.after(() => worker.terminate());

            const [widths] = await once(worker, 'message', { signal: AbortSignal.timeout(5000) });

            assert.deepEqual(widths, expected);
        });
    }
});
