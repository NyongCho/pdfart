import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

export const CHROME_PATH = process.env.CHROME_BIN ?? '/usr/bin/google-chrome';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const unrefDelay = milliseconds => new Promise(resolve => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
});
const runBounded = async (operation, timeoutMs) => {
    let timer;
    try {
        await Promise.race([
            Promise.resolve().then(operation),
            new Promise(resolve => {
                timer = setTimeout(resolve, timeoutMs);
                timer.unref();
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

export const runCleanupSteps = async operations => {
    const errors = [];
    for (const operation of operations) {
        try {
            await operation();
        } catch (error) {
            errors.push(error);
        }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Resource cleanup failed');
};

export const removeChromeProfile = async (directory, { remove = rm, maxRetries = 5, retryDelayMs = 50 } = {}) => {
    await remove(directory, { recursive: true, force: true, maxRetries, retryDelay: retryDelayMs });
};
const reservePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(error => error ? reject(error) : resolve(port));
    });
});
const fetchWithTimeout = (url, options = {}, timeoutMs = 10000) =>
    fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });

class CdpCommandTimeoutError extends Error {
    constructor(method, timeoutMs) {
        super(`CDP command timed out after ${timeoutMs} ms: ${method}`);
        this.name = 'CdpCommandTimeoutError';
        this.method = method;
        this.timeoutMs = timeoutMs;
    }
}

const waitForJson = async (url, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetchWithTimeout(url, {}, Math.min(1000, Math.max(1, deadline - Date.now())));
            if (response.ok) return response.json();
        } catch {
            // Chrome's debugging server may not be listening yet.
        }
        await delay(50);
    }
    throw new Error(`Timed out waiting for ${url}`);
};

export const createCdpClient = (socket, { close = async () => {}, onDiagnostic, commandTimeoutMs = 30000 } = {}) => {
    let nextId = 0;
    let disconnected = false;
    let closePromise;
    const pending = new Map();
    const listeners = new Map();
    const disconnectListeners = new Set();

    const rejectDisconnected = event => {
        if (disconnected) return;
        disconnected = true;
        const suffix = event?.reason ? `: ${event.reason}` : '';
        for (const [id, request] of pending) {
            clearTimeout(request.timeout);
            request.reject(new Error(`CDP WebSocket closed while waiting for ${request.method}${suffix}`));
            pending.delete(id);
        }
        for (const listener of disconnectListeners) listener();
        disconnectListeners.clear();
        listeners.clear();
    };

    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id) {
            const request = pending.get(message.id);
            if (!request) return;
            pending.delete(message.id);
            clearTimeout(request.timeout);
            if (message.error) request.reject(new Error(message.error.message));
            else request.resolve(message.result);
            return;
        }
        for (const listener of listeners.get(message.method) ?? []) listener(message.params);
    });
    socket.addEventListener('close', rejectDisconnected);
    socket.addEventListener('error', rejectDisconnected);

    const send = (method, params = {}, timeoutMs = commandTimeoutMs) => new Promise((resolve, reject) => {
        if (disconnected || socket.readyState !== 1) {
            reject(new Error(`CDP WebSocket closed before ${method}`));
            return;
        }
        const id = ++nextId;
        const timeout = setTimeout(() => {
            pending.delete(id);
            const error = new CdpCommandTimeoutError(method, timeoutMs);
            try {
                const diagnosticResult = onDiagnostic?.({ status: 'FAIL', phase: 'cdp.command', method, id, error: `timeout after ${timeoutMs} ms` });
                Promise.resolve(diagnosticResult).catch(diagnosticError => { error.cause = diagnosticError; });
            } catch (diagnosticError) {
                error.cause = diagnosticError;
            }
            reject(error);
        }, timeoutMs);
        pending.set(id, { method, resolve, reject, timeout });
        try {
            socket.send(JSON.stringify({ id, method, params }));
        } catch (error) {
            clearTimeout(timeout);
            pending.delete(id);
            reject(error);
        }
    });
    const on = (method, listener) => {
        const methodListeners = listeners.get(method) ?? new Set();
        methodListeners.add(listener);
        listeners.set(method, methodListeners);
        return () => {
            methodListeners.delete(listener);
            if (methodListeners.size === 0) listeners.delete(method);
        };
    };
    const onDisconnect = listener => {
        if (disconnected) {
            listener();
            return () => {};
        }
        disconnectListeners.add(listener);
        return () => disconnectListeners.delete(listener);
    };
    const evaluate = async (expression, timeoutMs) => {
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result.value;
    };
    const waitForExpression = async (expression, timeoutMs = 5000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const remaining = Math.max(1, deadline - Date.now());
            try {
                if (await evaluate(`Boolean(${expression})`, remaining)) return;
            } catch (error) {
                if (!(error instanceof CdpCommandTimeoutError) || error.method !== 'Runtime.evaluate') throw error;
                break;
            }
            await delay(Math.min(50, Math.max(0, deadline - Date.now())));
        }
        throw new Error(`Timed out waiting for expression: ${expression}`);
    };

    return {
        evaluate,
        getState: () => ({ pendingCommands: pending.size, eventListeners: [...listeners.values()].reduce((sum, set) => sum + set.size, 0), webSocketReadyState: socket.readyState }),
        on,
        onDisconnect,
        send,
        waitForExpression,
        close: () => closePromise ??= (async () => {
            rejectDisconnected({ reason: 'client closed' });
            if (socket.readyState < 2) socket.close();
            await close();
        })(),
    };
};

export const waitForCdpEvent = (client, method, { timeoutMs = 30000, timeoutDiagnosticMs = 2000, onStart, onEvent, onTimeout } = {}) => {
    let cancel = () => {};
    const promise = new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        let offEvent = () => {};
        let offDisconnect = () => {};
        const finish = (error, value, callback) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            offEvent();
            offDisconnect();
            void (async () => {
                let finalError = error;
                try {
                    if (callback) await runBounded(() => callback(error ?? value), timeoutDiagnosticMs);
                } catch (callbackError) {
                    if (finalError) finalError.cause = callbackError;
                    else finalError = callbackError;
                }
                if (finalError) reject(finalError);
                else resolve(value);
            })();
        };
        cancel = reason => finish(reason ?? new Error(`Cancelled waiting for CDP event: ${method}`));
        offEvent = client.on(method, value => finish(null, value, onEvent));
        offDisconnect = client.onDisconnect(() => finish(new Error(`CDP client closed while waiting for event: ${method}`)));
        if (settled) return;
        timer = setTimeout(() => {
            const error = new Error(`CDP event timed out after ${timeoutMs} ms: ${method}`);
            finish(error, undefined, onTimeout);
        }, timeoutMs);
        try {
            const startResult = onStart?.();
            Promise.resolve(startResult).catch(error => finish(error));
        } catch (error) {
            finish(error);
        }
    });
    promise.cancel = reason => cancel(reason);
    return promise;
};

const connectTarget = async (target, close, onDiagnostic, connectTimeoutMs = 10000) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`CDP WebSocket connection timed out after ${connectTimeoutMs} ms`)), connectTimeoutMs);
        socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener('error', event => { clearTimeout(timer); reject(event.error ?? new Error('CDP WebSocket connection failed')); }, { once: true });
    });
    return createCdpClient(socket, { close, onDiagnostic });
};

const stopOwnedProcess = async process => {
    if (process.exitCode !== null || process.signalCode !== null) return;
    const exited = new Promise(resolve => process.once('exit', resolve));
    process.kill('SIGTERM');
    if (!await Promise.race([exited.then(() => true), unrefDelay(5000).then(() => false)])) {
        if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
        await Promise.race([exited, unrefDelay(5000)]);
    }
};

export const launchChrome = async ({ onDiagnostic } = {}) => {
    const port = await reservePort();
    const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'pdfart-chrome-'));
    const process = spawn(CHROME_PATH, [
        '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
        '--disable-component-update', '--disable-default-apps', '--disable-extensions', '--disable-sync',
        '--metrics-recording-only', '--no-first-run', `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDirectory}`, 'about:blank',
    ], { stdio: 'ignore' });

    try {
        await waitForJson(`http://127.0.0.1:${port}/json/version`);
        const targetResponse = await fetchWithTimeout(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
        const target = await targetResponse.json();
        const client = await connectTarget(target, async () => {
            await stopOwnedProcess(process);
            await removeChromeProfile(userDataDirectory);
        }, onDiagnostic);
        return {
            ...client,
            createPage: async url => {
                const response = await fetchWithTimeout(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
                const pageTarget = await response.json();
                return connectTarget(pageTarget, async () => {
                    await fetchWithTimeout(`http://127.0.0.1:${port}/json/close/${pageTarget.id}`).catch(() => {});
                }, onDiagnostic);
            },
        };
    } catch (error) {
        await stopOwnedProcess(process);
        await removeChromeProfile(userDataDirectory);
        throw error;
    }
};
