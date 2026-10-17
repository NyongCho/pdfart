export const MAX_PDF_BYTES = 50 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 60_000;

const WORKER_ERROR_CODES = new Set([
    'INVALID_PASSWORD',
    'UNENCRYPTED_PDF',
    'PERMISSIONS_ONLY',
    'INVALID_PDF',
    'UNSUPPORTED_ENCRYPTION',
    'WARNING_OUTPUT_REJECTED',
    'ENGINE_LOAD_FAILED',
    'PROCESSING_FAILED',
]);

export class PdfUnlockError extends Error {
    constructor(code) {
        super(code);
        this.name = 'PdfUnlockError';
        this.code = code;
    }
}

const validateInput = (file, password) => {
    if (!file || typeof file.arrayBuffer !== 'function' || file.size === 0) {
        throw new PdfUnlockError('EMPTY_FILE');
    }
    if (file.size > MAX_PDF_BYTES) throw new PdfUnlockError('FILE_TOO_LARGE');
    if (typeof password !== 'string' || password.length === 0) {
        throw new PdfUnlockError('PASSWORD_REQUIRED');
    }
    if (password.includes('\0')) throw new PdfUnlockError('INVALID_PASSWORD_CHARACTER');
};

export const createPdfUnlocker = ({ loadAssets, createWorker }) => {
    let active = false;

    return async (file, password, options = {}) => {
        validateInput(file, password);
        if (active) throw new PdfUnlockError('JOB_IN_PROGRESS');
        if (options.signal?.aborted) throw new PdfUnlockError('ABORTED');
        active = true;

        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        let worker;
        let timer;
        let settled = false;
        let abortListener;
        const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

        try {
            return await new Promise((resolve, reject) => {
                const cleanup = () => {
                    if (timer !== undefined) clearTimeout(timer);
                    if (abortListener) options.signal?.removeEventListener('abort', abortListener);
                    if (worker) {
                        worker.removeEventListener('message', onMessage);
                        worker.removeEventListener('error', onWorkerError);
                        worker.removeEventListener('messageerror', onMessageError);
                        worker.terminate();
                        worker = undefined;
                    }
                };
                const finish = (callback, value) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    callback(value);
                };
                const fail = code => finish(reject, new PdfUnlockError(code));
                const onMessage = event => {
                    const message = event.data;
                    if (!message || message.id !== id) return;
                    if (message.type === 'success' && message.output instanceof ArrayBuffer) {
                        finish(resolve, new Uint8Array(message.output));
                        return;
                    }
                    if (message.type === 'error') {
                        fail(WORKER_ERROR_CODES.has(message.code) ? message.code : 'PROCESSING_FAILED');
                    }
                };
                const onWorkerError = () => fail('WORKER_CRASH');
                const onMessageError = () => fail('WORKER_MESSAGE_ERROR');

                abortListener = () => fail('ABORTED');
                options.signal?.addEventListener('abort', abortListener, { once: true });
                timer = setTimeout(() => fail('TIMEOUT'), timeoutMs);

                (async () => {
                    try {
                        const [assets, input] = await Promise.all([loadAssets(), file.arrayBuffer()]);
                        if (settled) return;
                        worker = createWorker();
                        worker.addEventListener('message', onMessage);
                        worker.addEventListener('error', onWorkerError);
                        worker.addEventListener('messageerror', onMessageError);
                        worker.postMessage({
                            id,
                            type: 'unlock',
                            input,
                            password,
                            coreJsUrl: assets.coreJsUrl,
                            wasmUrl: assets.wasmUrl,
                        }, [input]);
                    } catch (error) {
                        fail(error instanceof PdfUnlockError ? error.code : 'ENGINE_LOAD_FAILED');
                    }
                })();
            });
        } finally {
            active = false;
        }
    };
};

const defaultUnlockPdf = createPdfUnlocker({
    loadAssets: async () => {
        const { assets } = await import('@wasm-zoo/qpdf');
        return assets;
    },
    createWorker: () => {
        if (typeof Worker !== 'function') throw new PdfUnlockError('WORKER_UNSUPPORTED');
        return new Worker(new URL('../workers/pdfUnlock.worker.js', import.meta.url));
    },
});

export const unlockPdf = (...args) => defaultUnlockPdf(...args);
