import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    MAX_PDF_BYTES,
    PdfUnlockError,
    createPdfUnlocker,
} from '../src/utils/pdfUnlocker.js';

const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

class FakeWorker {
    constructor() {
        this.listeners = new Map();
        this.messages = [];
        this.terminateCount = 0;
    }

    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
        this.listeners.get(type)?.delete(listener);
    }

    postMessage(message, transfer) {
        this.messages.push({ message, transfer });
    }

    terminate() {
        this.terminateCount += 1;
    }

    emit(type, data) {
        for (const listener of this.listeners.get(type) ?? []) listener({ data });
    }
}

const pdfFile = (overrides = {}) => ({
    name: 'locked.pdf',
    size: 8,
    type: 'application/pdf',
    arrayBuffer: async () => Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 55]).buffer,
    ...overrides,
});

const expectCode = async (promise, code) => {
    await assert.rejects(promise, error => error instanceof PdfUnlockError && error.code === code);
};

const createHarness = (overrides = {}) => {
    const workers = [];
    const unlockPdf = createPdfUnlocker({
        loadAssets: async () => ({ coreJsUrl: '/core.js', wasmUrl: '/core.wasm' }),
        createWorker: () => {
            const worker = new FakeWorker();
            workers.push(worker);
            return worker;
        },
        ...overrides,
    });
    return { unlockPdf, workers };
};

describe('createPdfUnlocker', () => {
    it('rejects empty, oversized and missing-password inputs before loading the engine', async () => {
        let loads = 0;
        const { unlockPdf } = createHarness({ loadAssets: async () => { loads += 1; return {}; } });

        await expectCode(unlockPdf(pdfFile({ size: 0 }), 'pw'), 'EMPTY_FILE');
        await expectCode(unlockPdf(pdfFile({ size: MAX_PDF_BYTES + 1 }), 'pw'), 'FILE_TOO_LARGE');
        await expectCode(unlockPdf(pdfFile(), ''), 'PASSWORD_REQUIRED');
        await expectCode(unlockPdf(pdfFile(), 'a\0b'), 'INVALID_PASSWORD_CHARACTER');
        assert.equal(loads, 0);
    });

    it('preserves whitespace and Unicode passwords and returns only the matching success output', async () => {
        const { unlockPdf, workers } = createHarness();
        const resultPromise = unlockPdf(pdfFile({ type: '' }), '  한글 암호 🔐  ');
        await new Promise(resolve => setTimeout(resolve, 0));
        const [{ message, transfer }] = workers[0].messages;

        assert.equal(message.password, '  한글 암호 🔐  ');
        assert.equal(message.type, 'unlock');
        assert.equal(transfer.length, 1);
        workers[0].emit('message', { id: 'stale', type: 'success', output: new Uint8Array([9]).buffer });
        workers[0].emit('message', { id: message.id, type: 'success', output: new Uint8Array([4, 2]).buffer });

        assert.deepEqual(await resultPromise, new Uint8Array([4, 2]));
        assert.equal(workers[0].terminateCount, 1);
    });

    it('maps fixed worker errors without forwarding raw diagnostics', async () => {
        const { unlockPdf, workers } = createHarness();
        const resultPromise = unlockPdf(pdfFile(), 'not-the-password');
        await new Promise(resolve => setTimeout(resolve, 0));
        const { id } = workers[0].messages[0].message;
        workers[0].emit('message', {
            id,
            type: 'error',
            code: 'INVALID_PASSWORD',
            stderr: 'not-the-password secret engine text',
        });

        await expectCode(resultPromise, 'INVALID_PASSWORD');
        assert.equal(workers[0].terminateCount, 1);
    });

    it('aborts during asset import without constructing a worker', async () => {
        const assets = deferred();
        const controller = new AbortController();
        const { unlockPdf, workers } = createHarness({ loadAssets: () => assets.promise });
        const resultPromise = unlockPdf(pdfFile(), 'pw', { signal: controller.signal });
        controller.abort();
        assets.resolve({ coreJsUrl: '/late.js', wasmUrl: '/late.wasm' });

        await expectCode(resultPromise, 'ABORTED');
        assert.equal(workers.length, 0);
    });

    it('terminates an active worker on abort and ignores every late event', async () => {
        const controller = new AbortController();
        const { unlockPdf, workers } = createHarness();
        const resultPromise = unlockPdf(pdfFile(), 'pw', { signal: controller.signal });
        await new Promise(resolve => setTimeout(resolve, 0));
        const { id } = workers[0].messages[0].message;
        controller.abort();
        workers[0].emit('message', { id, type: 'success', output: new Uint8Array([7]).buffer });

        await expectCode(resultPromise, 'ABORTED');
        assert.equal(workers[0].terminateCount, 1);
    });

    it('uses one deadline for import and file reading, then permits the next job', async () => {
        const never = deferred();
        const { unlockPdf, workers } = createHarness({ loadAssets: () => never.promise });
        await expectCode(unlockPdf(pdfFile(), 'pw', { timeoutMs: 10 }), 'TIMEOUT');
        assert.equal(workers.length, 0);

        never.resolve({ coreJsUrl: '/core.js', wasmUrl: '/core.wasm' });
        const retry = unlockPdf(pdfFile(), 'pw', { timeoutMs: 1000 });
        await new Promise(resolve => setTimeout(resolve, 0));
        const { id } = workers[0].messages[0].message;
        workers[0].emit('message', { id, type: 'success', output: new Uint8Array([1]).buffer });
        assert.deepEqual(await retry, new Uint8Array([1]));
    });

    it('rejects concurrent work and recovers after worker crash and message corruption', async () => {
        const { unlockPdf, workers } = createHarness();
        const first = unlockPdf(pdfFile(), 'pw');
        await new Promise(resolve => setTimeout(resolve, 0));
        await expectCode(unlockPdf(pdfFile(), 'pw'), 'JOB_IN_PROGRESS');
        workers[0].emit('error');
        await expectCode(first, 'WORKER_CRASH');

        const second = unlockPdf(pdfFile(), 'pw');
        await new Promise(resolve => setTimeout(resolve, 0));
        workers[1].emit('messageerror');
        await expectCode(second, 'WORKER_MESSAGE_ERROR');
        assert.deepEqual(workers.map(worker => worker.terminateCount), [1, 1]);
    });

    it('preserves the fixed unsupported-Worker classification', async () => {
        const { unlockPdf } = createHarness({
            createWorker: () => { throw new PdfUnlockError('WORKER_UNSUPPORTED'); },
        });
        await expectCode(unlockPdf(pdfFile(), 'pw'), 'WORKER_UNSUPPORTED');
    });
});
