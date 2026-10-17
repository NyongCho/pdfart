import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
let outputDirectory;
let manifest;

const collectStaticEntryFiles = (entry) => {
    const files = new Set();
    const visit = (chunk) => {
        if (!chunk || files.has(chunk.file)) return;
        files.add(chunk.file);
        for (const imported of chunk.imports ?? []) visit(manifest[imported]);
    };
    visit(entry);
    return [...files];
};

before(async () => {
    outputDirectory = await mkdtemp(path.join(tmpdir(), 'pdfart-lazy-build-'));
    await build({
        root: projectRoot,
        logLevel: 'silent',
        build: {
            emptyOutDir: true,
            manifest: true,
            outDir: outputDirectory,
        },
    });
    manifest = JSON.parse(await readFile(path.join(outputDirectory, '.vite/manifest.json'), 'utf8'));
});

after(async () => {
    await rm(outputDirectory, { recursive: true, force: true });
});

it('keeps both PDF engines out of the production entry graph', async () => {
    const entry = Object.values(manifest).find(chunk => chunk.isEntry);
    assert.ok(entry, 'Vite manifest must identify the production entry');

    const initialFiles = collectStaticEntryFiles(entry);
    const initialCode = (await Promise.all(initialFiles
        .filter(file => file.endsWith('.js'))
        .map(file => readFile(path.join(outputDirectory, file), 'utf8')))).join('\n');

    assert.doesNotMatch(initialCode, /pdfjs-dist|pdf\.worker|PDFDocument/);
    assert.ok(
        Object.values(manifest).some(chunk => !initialFiles.includes(chunk.file) && /pdfManager/.test(chunk.name ?? chunk.src ?? '')),
        'pdf-lib must be reachable only through a deferred pdfManager chunk',
    );
    assert.ok(
        Object.values(manifest).some(chunk => !initialFiles.includes(chunk.file) && /pdfRenderer/.test(chunk.name ?? chunk.src ?? '')),
        'pdfjs-dist must be reachable only through a deferred pdfRenderer chunk',
    );
});
