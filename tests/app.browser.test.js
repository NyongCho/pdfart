import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
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
const visualEvidenceDirectory = process.env.PDFART_VISUAL_EVIDENCE_DIR;
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

const setViewport = async (width, height) => {
    const mobile = width < 768;
    await browser.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile,
    });
    await browser.send('Emulation.setEmulatedMedia', {
        features: [
            { name: 'hover', value: mobile ? 'none' : 'hover' },
            { name: 'pointer', value: mobile ? 'coarse' : 'fine' },
        ],
    });
};

const captureVisualEvidence = async (name) => {
    if (!visualEvidenceDirectory) return;
    await mkdir(visualEvidenceDirectory, { recursive: true });
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(visualEvidenceDirectory, `${name}.png`), Buffer.from(data, 'base64'));
};

const readStyleContract = () => browser.evaluate(`
    (() => {
        const heading = document.querySelector('h1');
        const tabList = heading.closest('div').querySelector('header + div');
        const panels = [...document.querySelectorAll('main, body *')].filter(element =>
            element.classList?.contains('min-h-[500px]')
        );
        const previewSurface = panels[1]?.querySelector('.shadow-inner');
        const badge = panels[0]?.querySelector('.rounded-full.border');
        const style = element => element ? getComputedStyle(element) : null;
        const rect = element => element ? element.getBoundingClientRect().toJSON() : null;

        return {
            viewport: { width: innerWidth, height: innerHeight },
            body: { backgroundColor: style(document.querySelector('#root > div')).backgroundColor },
            tabs: {
                borderRadius: style(tabList).borderRadius,
                borderTopWidth: style(tabList).borderTopWidth,
                boxShadow: style(tabList).boxShadow,
                buttonCursor: style(tabList.querySelector('button')).cursor,
            },
            panels: panels.map(panel => rect(panel)),
            previewSurface: {
                borderRadius: style(previewSurface).borderRadius,
                boxShadow: style(previewSurface).boxShadow,
            },
            badge: badge ? {
                borderColor: style(badge).borderColor,
                borderTopWidth: style(badge).borderTopWidth,
            } : null,
        };
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

it('preserves the production layout and visual utility contract', async () => {
    const contracts = {};

    for (const viewport of [
        { name: 'desktop', width: 1440, height: 1000 },
        { name: 'mobile', width: 390, height: 844 },
    ]) {
        await setViewport(viewport.width, viewport.height);
        await navigate();
        await captureVisualEvidence(`${viewport.name}-merge-empty`);

        const emptyMerge = await readStyleContract();
        assert.equal(emptyMerge.body.backgroundColor, 'rgb(241, 245, 249)');
        assert.equal(emptyMerge.tabs.borderRadius, '16px');
        assert.equal(emptyMerge.tabs.borderTopWidth, '1px');
        assert.notEqual(emptyMerge.tabs.boxShadow, 'none');
        assert.equal(emptyMerge.tabs.buttonCursor, 'pointer');
        assert.equal(emptyMerge.previewSurface.borderRadius, '16px');
        assert.notEqual(emptyMerge.previewSurface.boxShadow, 'none');
        assert.equal(emptyMerge.panels.length, 2);
        if (viewport.name === 'desktop') {
            assert.ok(Math.abs(emptyMerge.panels[0].top - emptyMerge.panels[1].top) < 1);
            assert.ok(emptyMerge.panels[1].left > emptyMerge.panels[0].right);
        } else {
            assert.ok(emptyMerge.panels[1].top > emptyMerge.panels[0].bottom);
        }

        await upload('input[type=file][multiple]', [pdfPath, secondPdfPath]);
        await browser.waitForExpression("document.querySelector('img[alt=\"Preview 1\"]')?.complete");
        await captureVisualEvidence(`${viewport.name}-merge-loaded`);
        const loadedMerge = await readStyleContract();
        assert.deepEqual(loadedMerge.badge, {
            borderColor: 'rgb(229, 231, 235)',
            borderTopWidth: '1px',
        });

        await clickButton('추출 (Split)');
        await new Promise(resolve => setTimeout(resolve, 250));
        await captureVisualEvidence(`${viewport.name}-split-empty`);
        await upload('input[type=file]:not([multiple])', splitPdfPath);
        await browser.waitForExpression("document.querySelector('img[alt=\"Page 2\"]')?.complete");
        const hoverTarget = await browser.evaluate(`
            (() => {
                const target = document.querySelector('img[alt="Page 1"]').closest('.group');
                target.scrollIntoView({ block: 'center', inline: 'center' });
                const { left, top, width, height } = target.getBoundingClientRect();
                return { x: left + width / 2, y: top + height / 2 };
            })()
        `);
        await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hoverTarget });
        await new Promise(resolve => setTimeout(resolve, 250));
        const hoverBackground = await browser.evaluate("getComputedStyle(document.querySelector('img[alt=\"Page 1\"]').closest('.group').lastElementChild).backgroundColor");
        if (viewport.name === 'desktop') {
            assert.equal(hoverBackground, 'rgba(147, 51, 234, 0.1)');
        }
        await captureVisualEvidence(`${viewport.name}-split-loaded${viewport.name === 'desktop' ? '-hover' : ''}`);

        await clickButton('개인정보처리방침');
        await browser.waitForExpression("document.querySelector('.fixed.inset-0') !== null");
        const modalStyle = await browser.evaluate(`
            (() => {
                const overlay = document.querySelector('.fixed.inset-0');
                const dialog = overlay.firstElementChild;
                return {
                    overlayBackground: getComputedStyle(overlay).backgroundColor,
                    backdropFilter: getComputedStyle(overlay).backdropFilter,
                    dialogBorderRadius: getComputedStyle(dialog).borderRadius,
                };
            })()
        `);
        assert.match(modalStyle.overlayBackground, /^(?:rgba\(0, 0, 0, 0\.5\)|oklab\(0 0 0 \/ 0\.5\))$/);
        assert.equal(modalStyle.backdropFilter, 'blur(4px)');
        assert.equal(modalStyle.dialogBorderRadius, '16px');
        await captureVisualEvidence(`${viewport.name}-privacy-modal`);

        contracts[viewport.name] = { emptyMerge, loadedMerge, hoverBackground, modalStyle };
    }

    if (visualEvidenceDirectory) {
        await writeFile(
            path.join(visualEvidenceDirectory, 'computed-styles.json'),
            `${JSON.stringify(contracts, null, 2)}\n`,
        );
    }
});

