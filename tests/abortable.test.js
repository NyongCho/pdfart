import assert from 'node:assert/strict';
import { it } from 'node:test';

import { abortable } from '../src/utils/abortable.js';

it('rejects a pending import when its operation deadline aborts', async () => {
    const controller = new AbortController();
    const pending = new Promise(() => {});
    const result = abortable(pending, controller.signal, () => new Error('deadline'));
    controller.abort();
    await assert.rejects(result, /deadline/);
});
