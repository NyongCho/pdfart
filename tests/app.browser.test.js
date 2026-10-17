import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { after, before, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { build, preview } from 'vite';
import { launchChrome, runCleanupSteps, waitForCdpEvent } from '../scripts/performance/cdp.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const visualEvidenceDirectory = process.env.PDFART_VISUAL_EVIDENCE_DIR;
let browser;
let outputDirectory;
let emptyPdfPath;
let longNamePdfPath;
let nonPdfPath;
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
    emptyPdfPath = path.join(outputDirectory, 'empty.pdf');
    await writeFile(emptyPdfPath, new Uint8Array());
    longNamePdfPath = path.join(outputDirectory, `${'a'.repeat(180)}.pdf`);
    await writeFile(longNamePdfPath, pdfBytes);
    nonPdfPath = path.join(outputDirectory, 'not-a-pdf.pdf');
    await writeFile(nonPdfPath, 'private-file-marker-not-a-pdf');
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

const setInputValue = (selector, value) => browser.evaluate(`
    (() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        if (!input) throw new Error('Missing input: ' + ${JSON.stringify(selector)});
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

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const observeNextWorkerTermination = () => {
    let workerId;
    let resolveCreated;
    let resolveDestroyed;
    const created = new Promise(resolve => { resolveCreated = resolve; });
    const destroyed = new Promise(resolve => { resolveDestroyed = resolve; });
    const offCreated = browser.on('Target.targetCreated', ({ targetInfo }) => {
        if (workerId || targetInfo.type !== 'worker') return;
        workerId = targetInfo.targetId;
        resolveCreated(workerId);
    });
    const offDestroyed = browser.on('Target.targetDestroyed', ({ targetId }) => {
        if (targetId === workerId) resolveDestroyed(targetId);
    });
    return {
        created,
        destroyed,
        close: () => { offCreated(); offDestroyed(); },
    };
};

const releasePausedRequest = async request => {
    try {
        await browser.send('Fetch.failRequest', { requestId: request.requestId, errorReason: 'Aborted' });
    } catch {
        // Terminating the Worker may remove the paused request first.
    }
    await browser.send('Fetch.disable');
};

const within = async (promise, timeoutMs, message) => {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

const readPdfJsRenderOracle = async bytes => {
    const normalizeRenderValue = value => {
        if (Array.isArray(value)) return value.map(normalizeRenderValue);
        if (ArrayBuffer.isView(value)) return [...value];
        if (typeof value === 'string') return value.replace(/g_d\d+_f/g, 'g_d*_f').replace(/^\d+R$/, '*R');
        return value;
    };
    const document = await getDocument({ data: new Uint8Array(bytes), disableWorker: true, useSystemFonts: true, verbosity: 0 }).promise;
    try {
        const page = await document.getPage(1);
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const [text, annotations, operators, outline, attachments, metadata] = await Promise.all([
            page.getTextContent(),
            page.getAnnotations(),
            page.getOperatorList(),
            document.getOutline(),
            document.getAttachments(),
            document.getMetadata(),
        ]);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        return {
            pages: document.numPages,
            text: text.items.map(item => item.str).filter(Boolean),
            annotations: annotations.map(annotation => ({
                subtype: annotation.subtype,
                url: annotation.url ?? null,
                fieldName: annotation.fieldName ?? null,
                fieldValue: annotation.fieldValue ?? null,
            })),
            operatorFunctions: [...operators.fnArray],
            operatorArguments: operators.argsArray.map(args => normalizeRenderValue(args ?? null)),
            outline: outline?.map(item => item.title) ?? [],
            attachments: Object.fromEntries(Object.entries(attachments ?? {}).map(([name, attachment]) => [
                name,
                sha256(attachment.content),
            ])),
            pageSize: [page.view[2] - page.view[0], page.view[3] - page.view[1]],
            rotationDegrees: page.rotate,
            title: metadata.info.Title,
            renderedPngSha256: createHash('sha256').update(canvas.toBuffer('image/png')).digest('hex'),
        };
    } finally {
        await document.destroy();
    }
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

it('offers an isolated, accessible password-unlock panel without eager engine loading', async () => {
    await navigate();
    const requests = [];
    const unsubscribe = browser.on('Network.requestWillBeSent', ({ request }) => requests.push(request.url));
    try {
        await clickButton('비밀번호 해제');
        await upload('input[type=file][data-mode=unlock]', pdfPath);
        const state = await browser.evaluate(`(() => {
            const password = document.querySelector('input[type=password]');
            const file = document.querySelector('input[type=file][data-mode=unlock]');
            const toggle = [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label')?.includes('비밀번호'));
            return {
                password: password && { autocomplete: password.autocomplete, spellcheck: password.spellcheck },
                file: Boolean(file),
                toggle: Boolean(toggle),
                previewDisabled: document.body.textContent.includes('비밀번호 해제에서는 미리보기를 제공하지 않습니다'),
                horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            };
        })()`);
        assert.deepEqual(state, {
            password: { autocomplete: 'off', spellcheck: false },
            file: true,
            toggle: true,
            previewDisabled: true,
            horizontalOverflow: false,
        });
        assert.equal(requests.some(request => /qpdf|pdfUnlock|pdfManager|pdfRenderer|pdf\.worker/.test(request)), false, requests.join('\n'));
    } finally {
        unsubscribe();
    }
});

it('rejects a line break before a single-line password can be silently changed', async () => {
    await navigate();
    await clickButton('비밀번호 해제');
    await upload('input[type=file][data-mode=unlock]', path.join(projectRoot, 'tests/fixtures/unlock/aes128.pdf'));
    const accepted = await browser.evaluate(`(() => {
        const input = document.querySelector('#unlock-password');
        input.focus();
        const event = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: { getData: () => 'first\\nsecond' } });
        return input.dispatchEvent(event);
    })()`);
    assert.equal(accepted, false);
    assert.equal(await browser.evaluate(`document.querySelector('[role=alert]')?.textContent.includes('줄바꿈')`), true);
    assert.equal(await browser.evaluate(`document.querySelector('#unlock-password').value`), '');
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

it('rejects a wrong password, clears it, then downloads a real unencrypted preserved PDF on retry', async () => {
    await navigate();
    const downloadDirectory = await mkdtemp(path.join(outputDirectory, 'unlock-download-'));
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory });
    await clickButton('비밀번호 해제');
    const sourcePath = path.join(projectRoot, 'tests/fixtures/unlock/aes128.pdf');
    const sourceBefore = await readFile(sourcePath);
    const manifest = JSON.parse(await readFile(path.join(projectRoot, 'tests/fixtures/unlock/manifest.json'), 'utf8'));
    assert.equal(sha256(sourceBefore), manifest.fixtures['aes128.pdf'].sha256);
    await upload('input[type=file][data-mode=unlock]', sourcePath);

    await setInputValue('#unlock-password', 'wrong-public-password');
    await clickButton('비밀번호 해제 다운로드');
    await browser.waitForExpression(`document.body.textContent.includes('비밀번호가 올바르지 않습니다')`, 10000);
    assert.equal(await browser.evaluate(`document.querySelector('#unlock-password').value`), '');
    assert.deepEqual(await readdir(downloadDirectory), []);

    await setInputValue('#unlock-password', 'public-AES128-pass');
    await clickButton('비밀번호 해제 다운로드');
    const downloadedPath = await waitForDownload(downloadDirectory);
    assert.match(path.basename(downloadedPath), /^aes128-unlocked\.pdf$/);
    const unlocked = await PDFDocument.load(await readFile(downloadedPath));
    assert.equal(unlocked.isEncrypted, false);
    assert.equal(unlocked.getPageCount(), 1);
    assert.equal(unlocked.getTitle(), 'PDFart synthetic unlock fidelity fixture');
    assert.equal(unlocked.getForm().getTextField('synthetic.name').getText(), 'fixture-value');
    assert.deepEqual(unlocked.getPages().map(page => [page.getWidth(), page.getHeight(), page.getRotation().angle]), [
        [...manifest.expectedContent.pageSize, manifest.expectedContent.rotationDegrees],
    ]);
    const [plainOracle, unlockedOracle] = await Promise.all([
        readPdfJsRenderOracle(await readFile(path.join(projectRoot, 'tests/fixtures/unlock/complex-plain.pdf'))),
        readPdfJsRenderOracle(await readFile(downloadedPath)),
    ]);
    assert.deepEqual(unlockedOracle, plainOracle, 'PDF.js must produce the same complete render command/content oracle');
    assert.deepEqual(unlockedOracle.attachments, {
        [manifest.expectedContent.attachment.name]: manifest.expectedContent.attachment.sha256,
    });
    assert.deepEqual(unlockedOracle.pageSize, manifest.expectedContent.pageSize);
    assert.equal(unlockedOracle.rotationDegrees, manifest.expectedContent.rotationDegrees);
    assert.equal(sha256(await readFile(sourcePath)), sha256(sourceBefore), 'the selected source file must remain byte-identical');
    assert.equal(await browser.evaluate(`document.querySelector('#unlock-password').value`), '');
});

it('terminates a cancelled real Worker, produces no late download, and recovers on the next job', async () => {
    await navigate();
    const directory = await mkdtemp(path.join(outputDirectory, 'unlock-cancel-'));
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: directory });
    await clickButton('비밀번호 해제');
    await upload('input[type=file][data-mode=unlock]', path.join(projectRoot, 'tests/fixtures/unlock/aes256-r6.pdf'));
    await setInputValue('#unlock-password', 'public-R6-pass');
    await browser.send('Fetch.enable', { patterns: [{ urlPattern: '*qpdf-core*.wasm*', requestStage: 'Request' }] });
    const paused = new Promise(resolve => {
        const off = browser.on('Fetch.requestPaused', event => { off(); resolve(event); });
    });
    await clickButton('비밀번호 해제 다운로드');
    const request = await paused;
    await clickButton('취소');
    try {
        await browser.send('Fetch.failRequest', { requestId: request.requestId, errorReason: 'Aborted' });
    } catch {
        // Terminating the Worker may remove the paused request before CDP releases it.
    }
    await browser.send('Fetch.disable');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(await readdir(directory), []);
    assert.equal(await browser.evaluate(`document.querySelector('#unlock-password').value`), '');

    await setInputValue('#unlock-password', 'public-R6-pass');
    await clickButton('비밀번호 해제 다운로드');
    const downloadedPath = await waitForDownload(directory);
    assert.equal((await PDFDocument.load(await readFile(downloadedPath))).isEncrypted, false);
});

it('terminates a paused real Worker on tab switch, suppresses late effects, and completes the next job', async () => {
    await navigate();
    const directory = await mkdtemp(path.join(outputDirectory, 'unlock-tab-switch-'));
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: directory });
    await browser.send('Target.setDiscoverTargets', { discover: true });
    const lifecycle = observeNextWorkerTermination();
    try {
        await clickButton('비밀번호 해제');
        await upload('input[type=file][data-mode=unlock]', path.join(projectRoot, 'tests/fixtures/unlock/aes256-r6.pdf'));
        await setInputValue('#unlock-password', 'public-R6-pass');
        await browser.send('Fetch.enable', { patterns: [{ urlPattern: '*qpdf-core*.wasm*', requestStage: 'Request' }] });
        const paused = new Promise(resolve => {
            const off = browser.on('Fetch.requestPaused', event => { off(); resolve(event); });
        });
        await clickButton('비밀번호 해제 다운로드');
        const [request] = await Promise.all([paused, lifecycle.created]);
        await clickButton('병합 (Merge)');
        await within(lifecycle.destroyed, 2000, 'tab switch did not terminate the paused Worker');
        await releasePausedRequest(request);
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.deepEqual(await readdir(directory), []);
        assert.equal(await browser.evaluate("document.querySelector('[role=alert]')?.textContent ?? ''"), '');
        assert.equal(await browser.evaluate("Boolean(document.querySelector('#unlock-password'))"), false);

        await clickButton('비밀번호 해제');
        await upload('input[type=file][data-mode=unlock]', path.join(projectRoot, 'tests/fixtures/unlock/aes256-r6.pdf'));
        await setInputValue('#unlock-password', 'public-R6-pass');
        await clickButton('비밀번호 해제 다운로드');
        assert.equal((await PDFDocument.load(await readFile(await waitForDownload(directory)))).isEncrypted, false);
    } finally {
        lifecycle.close();
        await browser.send('Fetch.disable').catch(() => {});
        await browser.send('Target.setDiscoverTargets', { discover: false });
    }
});

it('terminates a paused real Worker on file replacement, clears secrets, and completes the replacement job', async () => {
    await navigate();
    const directory = await mkdtemp(path.join(outputDirectory, 'unlock-file-replace-'));
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: directory });
    await browser.send('Target.setDiscoverTargets', { discover: true });
    const lifecycle = observeNextWorkerTermination();
    try {
        await clickButton('비밀번호 해제');
        await upload('input[type=file][data-mode=unlock]', path.join(projectRoot, 'tests/fixtures/unlock/aes256-r6.pdf'));
        await setInputValue('#unlock-password', 'public-R6-pass');
        await browser.send('Fetch.enable', { patterns: [{ urlPattern: '*qpdf-core*.wasm*', requestStage: 'Request' }] });
        const paused = new Promise(resolve => {
            const off = browser.on('Fetch.requestPaused', event => { off(); resolve(event); });
        });
        await clickButton('비밀번호 해제 다운로드');
        const [request] = await Promise.all([paused, lifecycle.created]);
        await upload('input[type=file][data-mode=unlock]', path.join(projectRoot, 'tests/fixtures/unlock/aes256-r5.pdf'));
        await within(lifecycle.destroyed, 2000, 'file replacement did not terminate the paused Worker');
        await releasePausedRequest(request);
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.deepEqual(await readdir(directory), []);
        assert.equal(await browser.evaluate("document.querySelector('#unlock-password').value"), '');
        assert.equal(await browser.evaluate("document.body.textContent.includes('aes256-r5.pdf')"), true);
        assert.equal(await browser.evaluate("document.querySelector('[role=alert]')?.textContent ?? ''"), '');

        await setInputValue('#unlock-password', 'public-R5-pass');
        await clickButton('비밀번호 해제 다운로드');
        assert.equal((await PDFDocument.load(await readFile(await waitForDownload(directory)))).isEncrypted, false);
    } finally {
        lifecycle.close();
        await browser.send('Fetch.disable').catch(() => {});
        await browser.send('Target.setDiscoverTargets', { discover: false });
    }
});

it('unlocks the supported matrix while allowing only expected static GET assets and no secret sinks', async () => {
    const fixtures = [
        ['aes256-r5.pdf', 'public-R5-pass'],
        ['aes256-r6.pdf', 'public-R6-pass'],
        ['rc4-128.pdf', 'public-RC4-128-pass'],
        ['rc4-40.pdf', 'public-RC4-40-pass'],
        ['unicode-spaces.pdf', '  한글 암호 🔐  '],
    ];
    const pageRequests = [];
    const workerRequests = [];
    const consoleValues = [];
    const exceptions = [];
    const socketTransports = [];
    let workerAttached = false;
    const offPageRequest = browser.on('Network.requestWillBeSent', event => pageRequests.push(event.request));
    const offPageConsole = browser.on('Runtime.consoleAPICalled', event => consoleValues.push(event.args));
    const offPageException = browser.on('Runtime.exceptionThrown', event => exceptions.push(event.exceptionDetails));
    const offPageSocket = browser.on('Network.webSocketCreated', event => socketTransports.push(event));
    const offPageTransport = browser.on('Network.webTransportCreated', event => socketTransports.push(event));
    const offWorkerMessage = browser.on('Target.receivedMessageFromTarget', event => {
        const message = JSON.parse(event.message);
        if (message.method === 'Network.requestWillBeSent') workerRequests.push(message.params.request);
        if (message.method === 'Runtime.consoleAPICalled') consoleValues.push(message.params.args);
        if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
        if (message.method === 'Network.webSocketCreated' || message.method === 'Network.webTransportCreated') {
            socketTransports.push(message.params);
        }
    });
    const offAttached = browser.on('Target.attachedToTarget', async event => {
        if (event.targetInfo.type !== 'worker') return;
        workerAttached = true;
        for (const [id, method] of [[1, 'Network.enable'], [2, 'Runtime.enable'], [3, 'Runtime.runIfWaitingForDebugger']]) {
            await browser.send('Target.sendMessageToTarget', {
                sessionId: event.sessionId,
                message: JSON.stringify({ id, method }),
            });
        }
    });

    await browser.send('Runtime.enable');
    await browser.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
    try {
        for (const [index, [filename, password]] of fixtures.entries()) {
            await navigate();
            const directory = await mkdtemp(path.join(outputDirectory, `unlock-matrix-${index}-`));
            await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: directory });
            await clickButton('비밀번호 해제');
            await upload('input[type=file][data-mode=unlock]', path.join(projectRoot, 'tests/fixtures/unlock', filename));
            await setInputValue('#unlock-password', password);
            await clickButton('비밀번호 해제 다운로드');
            const downloadedPath = await waitForDownload(directory);
            const unlocked = await PDFDocument.load(await readFile(downloadedPath));
            assert.equal(unlocked.isEncrypted, false);
            assert.equal(unlocked.getTitle(), 'PDFart synthetic unlock fidelity fixture');
        }
    } finally {
        await browser.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: false });
        offAttached();
        offWorkerMessage();
        offPageConsole();
        offPageException();
        offPageSocket();
        offPageTransport();
        offPageRequest();
    }

    assert.equal(workerAttached, true, 'the Worker observer must attach before privacy assertions count');
    assert.equal(workerRequests.some(request => /qpdf-core-.*\.js$/.test(request.url)), true, JSON.stringify(workerRequests));
    assert.equal(workerRequests.some(request => /qpdf-core-.*\.wasm$/.test(request.url)), true, JSON.stringify(workerRequests));
    const allRequests = [...pageRequests, ...workerRequests];
    const expectedAsset = /^\/(?:$|index\.html$|favicon\.svg$|assets\/(?:index|pdfUnlocker|pdfDownload|pdfUnlock\.worker|qpdf-core)-[^/]+\.(?:js|css|wasm)$)/;
    for (const request of allRequests) {
        const parsed = new URL(request.url);
        assert.equal(parsed.origin, new URL(url).origin, request.url);
        assert.equal(request.method, 'GET', JSON.stringify(request));
        assert.equal(parsed.search, '', request.url);
        assert.equal(parsed.hash, '', request.url);
        assert.equal(request.postData, undefined, JSON.stringify(request));
        assert.match(parsed.pathname, expectedAsset, request.url);
    }
    assert.deepEqual(socketTransports, []);
    assert.deepEqual(exceptions, []);
    const storage = await browser.evaluate(`(async () => ({
        local: Object.entries(localStorage),
        session: Object.entries(sessionStorage),
        indexedDb: indexedDB.databases ? await indexedDB.databases() : []
    }))()`);
    assert.deepEqual(storage, { local: [], session: [], indexedDb: [] });
    const captured = JSON.stringify({ allRequests, consoleValues, exceptions, socketTransports, storage });
    for (const marker of [
        ...fixtures.flat(),
        '한글 암호',
        'fixture-value',
        'PDFart unlock fidelity text',
    ]) {
        assert.doesNotMatch(captured, new RegExp(marker));
    }
});

it('returns fixed errors for plaintext, permissions-only, non-PDF, truncated, and unsupported inputs without a download', async () => {
    const cases = [
        { file: path.join(projectRoot, 'tests/fixtures/unlock/complex-plain.pdf'), password: 'public', message: '이미 비밀번호가 없는 PDF' },
        { file: path.join(projectRoot, 'tests/fixtures/unlock/owner-only.pdf'), password: 'public-owner', message: '권한 제한 문서' },
        { file: nonPdfPath, password: 'public', message: '손상되었거나 올바른 PDF' },
        { file: path.join(projectRoot, 'tests/fixtures/unlock/malformed-recoverable.pdf'), password: 'public', message: '문서 경고' },
        { file: path.join(projectRoot, 'tests/fixtures/unlock/unsupported-handler.pdf'), password: 'public', message: '지원하지 않는 PDF 암호화' },
    ];

    for (const [index, fixture] of cases.entries()) {
        await navigate();
        const directory = await mkdtemp(path.join(outputDirectory, `unlock-reject-${index}-`));
        await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: directory });
        await clickButton('비밀번호 해제');
        await upload('input[type=file][data-mode=unlock]', fixture.file);
        await setInputValue('#unlock-password', fixture.password);
        await clickButton('비밀번호 해제 다운로드');
        await browser.waitForExpression(`document.body.textContent.includes(${JSON.stringify(fixture.message)})`, 10000);
        assert.deepEqual(await readdir(directory), []);
    }
});

it('discards the previous file and password on empty or multiple-file replacement', async () => {
    await navigate();
    await clickButton('비밀번호 해제');
    const inputSelector = 'input[type=file][data-mode=unlock]';
    await upload(inputSelector, path.join(projectRoot, 'tests/fixtures/unlock/aes128.pdf'));
    await setInputValue('#unlock-password', 'must-clear');
    await upload(inputSelector, emptyPdfPath);
    assert.equal(await browser.evaluate(`document.body.textContent.includes('aes128.pdf')`), false);
    assert.equal(await browser.evaluate(`Boolean(document.querySelector('#unlock-password'))`), false);

    await upload(inputSelector, path.join(projectRoot, 'tests/fixtures/unlock/aes128.pdf'));
    await setInputValue('#unlock-password', 'must-clear-again');
    await browser.evaluate(`(() => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(['%PDF-1.7'], 'first.pdf', { type: 'application/pdf' }));
        transfer.items.add(new File(['%PDF-1.7'], 'second.pdf', { type: 'application/pdf' }));
        document.querySelector(${JSON.stringify(inputSelector)}).parentElement.dispatchEvent(
            new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
        );
    })()`);
    assert.equal(await browser.evaluate(`document.body.textContent.includes('aes128.pdf')`), false);
    assert.equal(await browser.evaluate(`Boolean(document.querySelector('#unlock-password'))`), false);
    assert.equal(await browser.evaluate(`document.querySelector('[role=alert]')?.textContent.includes('한 개만')`), true);
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

it('classifies a blocked unlock facade as a reload-required engine error and recovers after reload', async () => {
    const directory = await mkdtemp(path.join(outputDirectory, 'unlock-import-failure-'));
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: directory });
    await browser.send('Network.setBlockedURLs', { urls: ['*pdfUnlocker*'] });
    await navigate();
    await clickButton('비밀번호 해제');
    await upload('input[type=file][data-mode=unlock]', path.join(projectRoot, 'tests/fixtures/unlock/aes128.pdf'));
    await setInputValue('#unlock-password', 'public-AES128-pass');
    await clickButton('비밀번호 해제 다운로드');
    await browser.waitForExpression("document.querySelector('[role=alert]')?.textContent.includes('새로고침')", 10000);
    assert.equal(await browser.evaluate("document.body.textContent.includes('로컬에서 처리 중')"), false);
    assert.equal(await browser.evaluate("document.querySelector('#unlock-password').value"), '');
    assert.deepEqual(await readdir(directory), []);

    await browser.send('Network.setBlockedURLs', { urls: [] });
    await setInputValue('#unlock-password', 'public-AES128-pass');
    await clickButton('비밀번호 해제 다운로드');
    await browser.waitForExpression("document.querySelector('[role=alert]')?.textContent.includes('새로고침')", 10000);
    assert.deepEqual(await readdir(directory), [], 'a cached failed import must not pretend that same-page retry can recover');

    await navigate();
    await clickButton('비밀번호 해제');
    await upload('input[type=file][data-mode=unlock]', path.join(projectRoot, 'tests/fixtures/unlock/aes128.pdf'));
    await setInputValue('#unlock-password', 'public-AES128-pass');
    await clickButton('비밀번호 해제 다운로드');
    assert.equal((await PDFDocument.load(await readFile(await waitForDownload(directory)))).isEncrypted, false);
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
        { name: 'desktop', width: 1280, height: 1000 },
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

        await clickButton('비밀번호 해제');
        await upload('input[type=file][data-mode=unlock]', viewport.name === 'mobile'
            ? longNamePdfPath
            : path.join(projectRoot, 'tests/fixtures/unlock/aes128.pdf'));
        await captureVisualEvidence(`${viewport.name}-unlock-loaded`);
        assert.equal(await browser.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth`), false);
        assert.equal(await browser.evaluate(`document.querySelector('label[for=unlock-password]')?.textContent.includes('비밀번호')`), true);

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

