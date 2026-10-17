import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { it } from 'node:test';
import { createCdpClient, removeChromeProfile, runCleanupSteps, waitForCdpEvent } from '../scripts/performance/cdp.mjs';

class FakeSocket extends EventEmitter {
    static OPEN = 1;

    readyState = FakeSocket.OPEN;
    sent = [];

    addEventListener(type, listener, options = {}) {
        if (options.once) this.once(type, listener);
        else this.on(type, listener);
    }

    removeEventListener(type, listener) {
        this.off(type, listener);
    }

    send(message) {
        this.sent.push(JSON.parse(message));
    }

    close() {
        this.readyState = 3;
        this.emit('close', { code: 1000, reason: 'test close' });
    }
}

const elapsed = async operation => {
    const started = performance.now();
    try {
        await operation();
        assert.fail('Expected operation to reject');
    } catch (error) {
        return { error, durationMs: performance.now() - started };
    }
};

it('bounds a withheld CDP response and names the method', async () => {
    const client = createCdpClient(new FakeSocket(), { commandTimeoutMs: 50 });

    const { error, durationMs } = await elapsed(() => client.send('Page.navigate'));

    assert.match(error.message, /CDP command timed out.*Page\.navigate/);
    assert.ok(durationMs < 500, `Expected a bounded rejection, took ${durationMs} ms`);
    assert.equal(client.getState().pendingCommands, 0);
});

it('preserves a command timeout when command diagnostics throw', async () => {
    const client = createCdpClient(new FakeSocket(), {
        commandTimeoutMs: 25,
        onDiagnostic: async () => { throw new Error('command diagnostic failed'); },
    });

    const { error, durationMs } = await elapsed(() => client.send('Page.navigate'));

    assert.match(error.message, /CDP command timed out.*Page\.navigate/);
    assert.ok(durationMs < 250, `Expected a bounded rejection, took ${durationMs} ms`);
    assert.equal(client.getState().pendingCommands, 0);
});

it('cleans pending command state when WebSocket send throws synchronously', async () => {
    const socket = new FakeSocket();
    socket.send = () => { throw new Error('socket write failed'); };
    const client = createCdpClient(socket, { commandTimeoutMs: 500 });

    await assert.rejects(client.send('Page.navigate'), /socket write failed/);

    assert.equal(client.getState().pendingCommands, 0);
});

it('bounds a missing CDP event and names the event', async () => {
    const client = createCdpClient(new FakeSocket());

    const { error, durationMs } = await elapsed(() => waitForCdpEvent(client, 'Page.loadEventFired', { timeoutMs: 50 }));

    assert.match(error.message, /CDP event timed out.*Page\.loadEventFired/);
    assert.ok(durationMs < 500, `Expected a bounded rejection, took ${durationMs} ms`);
});

it('does not let timeout diagnostics delay a missing-event rejection indefinitely', async () => {
    const client = createCdpClient(new FakeSocket());

    const { error, durationMs } = await elapsed(() => waitForCdpEvent(client, 'Page.loadEventFired', {
        timeoutMs: 50,
        timeoutDiagnosticMs: 50,
        onTimeout: () => new Promise(() => {}),
    }));

    assert.match(error.message, /CDP event timed out.*Page\.loadEventFired/);
    assert.ok(durationMs < 500, `Expected bounded timeout diagnostics, took ${durationMs} ms`);
});

it('preserves the event timeout when timeout diagnostics throw', async () => {
    const client = createCdpClient(new FakeSocket());

    const { error, durationMs } = await elapsed(() => waitForCdpEvent(client, 'Page.loadEventFired', {
        timeoutMs: 25,
        timeoutDiagnosticMs: 25,
        onTimeout: () => { throw new Error('diagnostic failed'); },
    }));

    assert.match(error.message, /CDP event timed out.*Page\.loadEventFired/);
    assert.ok(durationMs < 250, `Expected a bounded rejection, took ${durationMs} ms`);
});

it('settles and removes listeners when an event callback throws', async () => {
    const socket = new FakeSocket();
    const client = createCdpClient(socket);
    const event = waitForCdpEvent(client, 'Page.loadEventFired', {
        timeoutMs: 500,
        onEvent: () => { throw new Error('event diagnostic failed'); },
    });

    socket.emit('message', { data: JSON.stringify({ method: 'Page.loadEventFired', params: {} }) });

    await assert.rejects(event, /event diagnostic failed/);
    assert.equal(client.getState().eventListeners, 0);
});

it('does not start diagnostics or timers when subscribing after disconnect', async () => {
    const socket = new FakeSocket();
    const client = createCdpClient(socket);
    socket.readyState = 3;
    socket.emit('close', { reason: 'already gone' });
    let starts = 0;

    await assert.rejects(
        waitForCdpEvent(client, 'Page.loadEventFired', { timeoutMs: 500, onStart: () => { starts += 1; } }),
        /CDP client closed.*Page\.loadEventFired/,
    );

    assert.equal(starts, 0);
    assert.equal(client.getState().eventListeners, 0);
});

it('cancels an event subscription when its triggering command fails', async () => {
    const client = createCdpClient(new FakeSocket());
    const event = waitForCdpEvent(client, 'Page.loadEventFired', { timeoutMs: 500 });

    event.cancel(new Error('Page.navigate failed'));

    await assert.rejects(event, /Page\.navigate failed/);
    assert.equal(client.getState().eventListeners, 0);
});

it('registers the event listener synchronously before invoking the trigger hook', async () => {
    const socket = new FakeSocket();
    const client = createCdpClient(socket);

    const event = await waitForCdpEvent(client, 'Page.loadEventFired', {
        timeoutMs: 50,
        onStart: () => socket.emit('message', { data: JSON.stringify({ method: 'Page.loadEventFired', params: { frameId: 'ready' } }) }),
    });

    assert.deepEqual(event, { frameId: 'ready' });
});

it('rejects pending commands and event listeners promptly when the socket disconnects', async () => {
    const socket = new FakeSocket();
    const client = createCdpClient(socket, { commandTimeoutMs: 5000 });
    const command = client.send('Runtime.evaluate');
    const event = waitForCdpEvent(client, 'Page.loadEventFired', { timeoutMs: 5000 });

    socket.readyState = 3;
    socket.emit('close', { code: 1006, reason: 'connection lost' });

    await assert.rejects(command, /CDP WebSocket closed.*Runtime\.evaluate/);
    await assert.rejects(event, /CDP client closed.*Page\.loadEventFired/);
    assert.deepEqual(client.getState(), { pendingCommands: 0, eventListeners: 0, webSocketReadyState: 3 });
});

it('does not let a withheld Runtime.evaluate outlive waitForExpression', async () => {
    const client = createCdpClient(new FakeSocket(), { commandTimeoutMs: 5000 });

    const { error, durationMs } = await elapsed(() => client.waitForExpression('window.ready', 50));

    assert.match(error.message, /Timed out waiting for expression: window\.ready/);
    assert.ok(durationMs < 500, `Expected the outer timeout to win, took ${durationMs} ms`);
    assert.equal(client.getState().pendingCommands, 0);
});

it('attempts every acquired-resource cleanup and reports earlier failures', async () => {
    const calls = [];

    await assert.rejects(() => runCleanupSteps([
        async () => { calls.push('browser'); throw new Error('profile cleanup failed'); },
        async () => { calls.push('server'); },
        async () => { calls.push('output'); },
    ]), error => {
        assert(error instanceof globalThis.AggregateError);
        assert.match(error.message, /cleanup failed/i);
        assert.match(error.errors[0].message, /profile cleanup failed/);
        return true;
    });

    assert.deepEqual(calls, ['browser', 'server', 'output']);
});

it('delegates one bounded retry policy to filesystem profile removal', async () => {
    let attempts = 0;
    let receivedOptions;
    const remove = async (_directory, options) => {
        attempts += 1;
        receivedOptions = options;
        throw Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });
    };

    await assert.rejects(
        () => removeChromeProfile('/tmp/test-profile', { remove, maxRetries: 2, retryDelayMs: 1 }),
        /directory not empty/,
    );

    assert.equal(attempts, 1);
    assert.deepEqual(receivedOptions, { recursive: true, force: true, maxRetries: 2, retryDelay: 1 });
});
