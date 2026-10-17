import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLogger, createServer } from 'vite';

it('serves the entry HTML without parser warnings', async () => {
    const warnings = [];
    const logger = createLogger('silent');
    logger.warn = message => warnings.push(message);
    const server = await createServer({
        root: fileURLToPath(new URL('../', import.meta.url)),
        configFile: false,
        customLogger: logger,
        server: { middlewareMode: true, ws: false, watch: null, preTransformRequests: false },
        optimizeDeps: { noDiscovery: true },
    });

    try {
        const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
        await server.transformIndexHtml('/', html);

        assert.deepEqual(warnings, []);
    } finally {
        await server.close();
    }
});
