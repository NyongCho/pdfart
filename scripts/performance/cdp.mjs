import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

const reservePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(error => error ? reject(error) : resolve(port));
    });
});

const waitForJson = async (url, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            if (response.ok) return response.json();
        } catch {
            // Chrome's debugging server may not be listening yet.
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${url}`);
};

const connectTarget = async (target, close) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });

    let nextId = 0;
    const pending = new Map();
    const listeners = new Map();
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id) {
            const request = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) request.reject(new Error(message.error.message));
            else request.resolve(message.result);
            return;
        }
        for (const listener of listeners.get(message.method) ?? []) listener(message.params);
    });

    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
    });
    const on = (method, listener) => {
        const methodListeners = listeners.get(method) ?? new Set();
        methodListeners.add(listener);
        listeners.set(method, methodListeners);
        return () => methodListeners.delete(listener);
    };
    const evaluate = async (expression) => {
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result.value;
    };
    const waitForExpression = async (expression, timeout = 5000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            if (await evaluate(`Boolean(${expression})`)) return;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error(`Timed out waiting for expression: ${expression}`);
    };

    return {
        evaluate,
        on,
        send,
        waitForExpression,
        close: async () => {
            socket.close();
            await close();
        },
    };
};

export const launchChrome = async () => {
    const port = await reservePort();
    const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'pdfart-chrome-'));
    const process = spawn('/usr/bin/google-chrome', [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-first-run',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDirectory}`,
        'about:blank',
    ], { stdio: 'ignore' });

    try {
        await waitForJson(`http://127.0.0.1:${port}/json/version`);
        const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
        const stopProcess = async () => {
            if (process.exitCode !== null || process.signalCode !== null) return;
            const exited = new Promise(resolve => process.once('exit', resolve));
            process.kill('SIGTERM');
            await exited;
        };

        const client = await connectTarget(target, async () => {
                await stopProcess();
                await rm(userDataDirectory, { recursive: true, force: true });
        });
        return {
            ...client,
            createPage: async url => {
                const pageTarget = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then(response => response.json());
                return connectTarget(pageTarget, async () => {
                    await fetch(`http://127.0.0.1:${port}/json/close/${pageTarget.id}`);
                });
            },
        };
    } catch (error) {
        if (process.exitCode === null && process.signalCode === null) {
            const exited = new Promise(resolve => process.once('exit', resolve));
            process.kill('SIGTERM');
            await exited;
        }
        await rm(userDataDirectory, { recursive: true, force: true });
        throw error;
    }
};

