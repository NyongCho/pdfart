import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { after, before, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { build, preview } from 'vite';
import { launchChrome, runCleanupSteps, waitForCdpEvent } from '../scripts/performance/cdp.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
let browser;
let outputDirectory;
let pdfPath;
let splitPdfPath;
let secondPdfPath;
let server;
let url;

before(async () => {
    outputDirectory = await mkdtemp(path.join(tmpdir(), 'pdfart-browser-'));
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    pdf.addPage([300, 200]);
    pdfPath = path.join(outputDirectory, 'fixture.pdf');
    const pdfBytes = await pdf.save();
    await writeFile(pdfPath, pdfBytes);
    splitPdfPath = path.join(outputDirectory, 'split-fixture.pdf');
    await writeFile(splitPdfPath, pdfBytes);
    const secondPdf = await PDFDocument.create();
    secondPdf.addPage([400, 200]);
    secondPdfPath = path.join(outputDirectory, 'second.pdf');
    await writeFile(secondPdfPath, await secondPdf.save());

    await build({ root: projectRoot, logLevel: 'silent', build: { outDir: path.join(outputDirectory, 'dist') } });
    server = await preview({
        root: projectRoot,
        logLevel: 'silent',
        build: { outDir: path.join(outputDirectory, 'dist') },
        preview: { host: '127.0.0.1', port: 0 },
    });
    const address = server.httpServer.address();
    url = `http://127.0.0.1:${address.port}/`;
    browser = await launchChrome();
    await browser.send('Page.enable');
    await browser.send('Network.enable');
    await browser.send('Network.setCacheDisabled', { cacheDisabled: true });
});

after(async () => {
    const cleanupTrace = (status, stage, error) => {
        if (process.env.PDFART_TEST_CLEANUP_DIAGNOSTICS !== '1') return;
        process.stderr.write(`${JSON.stringify({
            timestamp: new Date().toISOString(),
            status,
            stage,
            activeResources: process.getActiveResourcesInfo(),
            ...(error ? { error: error.stack ?? error.message } : {}),
        })}\n`);
    };
    const cleanupStage = async (stage, operation) => {
        cleanupTrace('START', stage);
        try {
            await operation();
            cleanupTrace('END', stage);
        } catch (error) {
            cleanupTrace('FAIL', stage, error);
            throw error;
        }
    };

    await runCleanupSteps([
        () => cleanupStage('browser.close', () => browser?.close()),
        () => cleanupStage('server.close', () => server?.close()),
        () => cleanupStage('output.rm', () => rm(outputDirectory, { recursive: true, force: true })),
    ]);
    cleanupTrace('END', 'after');
});

const navigate = async () => {
    const loaded = waitForCdpEvent(browser, 'Page.loadEventFired', { timeoutMs: 10000 });
    const navigation = browser.send('Page.navigate', { url });
    try {
        await Promise.all([navigation, loaded]);
    } finally {
        loaded.cancel(new Error('Page.navigate scope ended'));
    }
};

const upload = async (selector, files) => {
    const { root } = await browser.send('DOM.getDocument');
    const { nodeId } = await browser.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    assert.ok(nodeId, `Expected file input ${selector}`);
    await browser.send('DOM.setFileInputFiles', { nodeId, files: Array.isArray(files) ? files : [files] });
};

const clickButton = text => browser.evaluate(`
    [...document.querySelectorAll('button')].find(button => button.textContent.includes(${JSON.stringify(text)}))?.click()
`);

const setTextInput = value => browser.evaluate(`
    (() => {
        const input = document.querySelector('input[type=text]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
    })()
`);

const waitForDownload = async (directory) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const files = (await readdir(directory)).filter(file => !file.endsWith('.crdownload'));
        if (files.length > 0) return path.join(directory, files[0]);
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for a PDF download');
};

it('completes repeated same-URL navigation without losing the load event', async () => {
    await navigate();
    await navigate();

    assert.equal(await browser.evaluate("document.readyState === 'complete' && document.querySelector('h1')?.textContent.includes('PDFart')"), true);
});

it('does not request a PDF engine while the page is empty', async () => {
    const requests = [];
    const off = browser.on('Network.requestWillBeSent', ({ request }) => requests.push(request.url));
    await navigate();
    await new Promise(resolve => setTimeout(resolve, 200));
    off();

    assert.equal(requests.some(request => /pdf(?:Manager|Renderer|\.worker)/.test(request)), false, requests.join('\n'));
});

it('shows a preview loading failure and recovers its loading state', async () => {
    await browser.send('Network.setBlockedURLs', { urls: ['*pdfRenderer*'] });
    await navigate();
    await upload('input[type=file][multiple]', pdfPath);

    await browser.waitForExpression("document.querySelector('[role=alert]')?.textContent.includes('미리보기')");
    assert.equal(await browser.evaluate("document.body.textContent.includes('미리보기 불러오는 중')"), false);
    await browser.send('Network.setBlockedURLs', { urls: [] });
});

it('renders merge and split previews after their first deferred engine load', async () => {
    await navigate();
    await upload('input[type=file][multiple]', pdfPath);
    await browser.waitForExpression("document.querySelector('img[alt=\"Preview 0\"]')?.src.startsWith('data:image/png')");

    await clickButton('추출 (Split)');
    await upload('input[type=file]:not([multiple])', splitPdfPath);
    try {
        await browser.waitForExpression("document.querySelector('img[alt=\"Page 2\"]')?.src.startsWith('data:image/png')");
    } catch (error) {
        error.message += `\nPage text: ${await browser.evaluate('document.body.textContent')}`;
        throw error;
    }
});

it('ignores a stale preview import failure after switching modes', async () => {
    await navigate();
    await browser.send('Fetch.enable', { patterns: [{ urlPattern: '*pdfRenderer*', requestStage: 'Request' }] });
    const paused = new Promise(resolve => {
        const off = browser.on('Fetch.requestPaused', event => {
            off();
            resolve(event);
        });
    });
    await upload('input[type=file][multiple]', pdfPath);
    const request = await paused;
    await clickButton('추출 (Split)');
    await browser.send('Fetch.failRequest', { requestId: request.requestId, errorReason: 'Failed' });
    await browser.send('Fetch.disable');
    await new Promise(resolve => setTimeout(resolve, 200));

    assert.equal(await browser.evaluate("document.querySelector('[role=alert]')?.textContent ?? ''"), '');
    assert.equal(await browser.evaluate("document.body.textContent.includes('파일을 선택하면 모든 페이지가 표시됩니다.')"), true);
});

it('downloads merged and split PDFs through the deferred action engine', async () => {
    const downloadDirectory = path.join(outputDirectory, 'downloads');
    await mkdir(downloadDirectory);
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory });

    await navigate();
    await upload('input[type=file][multiple]', [pdfPath, secondPdfPath]);
    await clickButton('병합 다운로드');
    const mergedPath = await waitForDownload(downloadDirectory);
    const merged = await PDFDocument.load(await readFile(mergedPath));
    assert.deepEqual(merged.getPages().map(page => page.getWidth()), [200, 300, 400]);

    await rm(downloadDirectory, { recursive: true, force: true });
    await mkdir(downloadDirectory);
    await clickButton('추출 (Split)');
    await upload('input[type=file]:not([multiple])', splitPdfPath);
    await setTextInput('2');
    await clickButton('추출 다운로드');
    const splitPath = await waitForDownload(downloadDirectory);
    const split = await PDFDocument.load(await readFile(splitPath));
    assert.deepEqual(split.getPages().map(page => page.getWidth()), [300]);
});

it('shows an action import failure and clears the processing state', async () => {
    await browser.send('Network.setBlockedURLs', { urls: ['*pdfManager*'] });
    await navigate();
    await upload('input[type=file][multiple]', [pdfPath, secondPdfPath]);
    await clickButton('병합 다운로드');
    await browser.waitForExpression("document.querySelector('[role=alert]')?.textContent.includes('PDF 병합')");

    assert.equal(await browser.evaluate("document.body.textContent.includes('처리 중...')"), false);
    await browser.send('Network.setBlockedURLs', { urls: [] });
});

it('clears a failed merge message when switching to split mode', async () => {
    await browser.send('Network.setBlockedURLs', { urls: ['*pdfManager*'] });
    await navigate();
    await upload('input[type=file][multiple]', [pdfPath, secondPdfPath]);
    await clickButton('병합 다운로드');
    await browser.waitForExpression("document.querySelector('[role=alert]')?.textContent.includes('PDF 병합')");
    await browser.send('Network.setBlockedURLs', { urls: [] });

    await clickButton('추출 (Split)');
    assert.equal(await browser.evaluate("document.querySelector('[role=alert]')?.textContent ?? ''"), '');
});

