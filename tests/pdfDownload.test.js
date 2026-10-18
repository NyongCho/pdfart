import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { downloadPdf } from '../src/utils/pdfDownload.js';

describe('downloadPdf', () => {
    it('clicks one PDF download and revokes its object URL', () => {
        const calls = [];
        const link = {
            click: () => calls.push('click'),
            remove: () => calls.push('remove'),
        };
        const documentRef = {
            body: { append: value => calls.push(['append', value]) },
            createElement: tag => {
                assert.equal(tag, 'a');
                return link;
            },
        };
        const urlApi = {
            createObjectURL: blob => {
                assert.equal(blob.type, 'application/pdf');
                return 'blob:pdfart-test';
            },
            revokeObjectURL: url => calls.push(['revoke', url]),
        };

        downloadPdf(new Uint8Array([1, 2, 3]), 'sample-unlocked.pdf', { documentRef, urlApi });

        assert.equal(link.href, 'blob:pdfart-test');
        assert.equal(link.download, 'sample-unlocked.pdf');
        assert.deepEqual(calls, [
            ['append', link],
            'click',
            'remove',
            ['revoke', 'blob:pdfart-test'],
        ]);
    });

    it('revokes the object URL even when the synthetic click fails', () => {
        const revoked = [];
        const documentRef = {
            body: { append: () => {} },
            createElement: () => ({ click: () => { throw new Error('blocked'); }, remove: () => {} }),
        };
        const urlApi = {
            createObjectURL: () => 'blob:must-revoke',
            revokeObjectURL: url => revoked.push(url),
        };

        assert.throws(
            () => downloadPdf(new Uint8Array([1]), 'sample.pdf', { documentRef, urlApi }),
            /blocked/,
        );
        assert.deepEqual(revoked, ['blob:must-revoke']);
    });
});
