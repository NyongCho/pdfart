#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { launchChrome } from './cdp.mjs';

const MIME_TYPES = {
    '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};
const COMPRESSIBLE_EXTENSIONS = new Set(['.css', '.html', '.js', '.mjs', '.svg']);
const PROFILES = {
    local: { latencyMs: 0, downloadBytesPerSecond: -1, uploadBytesPerSecond: -1, cpuRate: 1 },
    throttled: { latencyMs: 40, downloadBytesPerSecond: 1_600_000 / 8, uploadBytesPerSecond: 750_000 / 8, cpuRate: 4 },
};
const ALL_SCENARIOS = ['initial', 'preview-small', 'preview-large', 'merge-small', 'merge-large', 'split-small', 'split-large'];

const parseArgs = () => {
    const values = {};
    for (let index = 2; index < process.argv.length; index += 2) {
        const key = process.argv[index];
        if (!key.startsWith('--') || process.argv[index + 1] === undefined) throw new Error(`Expected --name value, received ${key}`);
        values[key.slice(2)] = process.argv[index + 1];
    }
    for (const required of ['baseline', 'candidate', 'output']) {
        if (!values[required]) throw new Error(`Missing --${required}`);
    }
    return {
        ...values,
        baseline: path.resolve(values.baseline),
        candidate: path.resolve(values.candidate),
        output: path.resolve(values.output),
        samples: Number(values.samples ?? 20),
        profiles: (values.profiles ?? 'local,throttled').split(','),
        scenarios: (values.scenarios ?? ALL_SCENARIOS.join(',')).split(','),
    };
};

const createPdf = (pageCount, shapesPerPage) => {
    const pageReferences = Array.from({ length: pageCount }, (_, index) => `${3 + index * 2} 0 R`).join(' ');
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        `<< /Type /Pages /Count ${pageCount} /Kids [${pageReferences}] >>`,
    ];
    for (let page = 0; page < pageCount; page++) {
        const pageObject = 3 + page * 2;
        const contentObject = pageObject + 1;
        const commands = Array.from({ length: shapesPerPage }, (_, index) => {
            const x = (index * 17) % 560;
            const y = (index * 29) % 760;
            return `${x} ${y} 20 10 re S`;
        }).join('\n');
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents ${contentObject} 0 R >>`);
        objects.push(`<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`);
    }

    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((object, index) => {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf);
};

const startStaticServer = async (directory) => {
    const server = createServer(async (request, response) => {
        try {
            const requestPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
            if (requestPath === '/__benchmark_blank.html') {
                response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/html' });
                response.end('<!doctype html><title>benchmark blank</title>');
                return;
            }
            const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\//, '');
            const file = path.resolve(directory, relative);
            if (!file.startsWith(`${directory}${path.sep}`) && file !== path.join(directory, 'index.html')) throw new Error('Invalid path');
            const data = await readFile(file);
            const extension = path.extname(file);
            const shouldCompress = COMPRESSIBLE_EXTENSIONS.has(extension) && /\bgzip\b/.test(request.headers['accept-encoding'] ?? '');
            const body = shouldCompress ? gzipSync(data) : data;
            response.writeHead(200, {
                'cache-control': 'public, max-age=31536000, immutable',
                'content-encoding': shouldCompress ? 'gzip' : 'identity',
                'content-length': body.length,
                'content-type': MIME_TYPES[extension] ?? 'application/octet-stream',
                'vary': 'accept-encoding',
            });
            response.end(body);
        } catch {
            response.writeHead(404).end('Not found');
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return {
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    };
};

const percentile = (values, fraction) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
};

const hashDirectory = async (directory, current = directory) => {
    const hashes = {};
    for (const entry of await readdir(current, { withFileTypes: true })) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) Object.assign(hashes, await hashDirectory(directory, entryPath));
        else hashes[path.relative(directory, entryPath)] = createHash('sha256').update(await readFile(entryPath)).digest('hex');
    }
    return hashes;
};

const summarize = (runs) => {
    const groups = new Map();
    for (const run of runs) {
        const key = [run.variant, run.profile, run.cache, run.scenario].join('|');
        const group = groups.get(key) ?? [];
        group.push(run);
        groups.set(key, group);
    }
    return [...groups].map(([key, group]) => {
        const [variant, profile, cache, scenario] = key.split('|');
        const metricNames = Object.keys(group[0].metrics);
        return {
            variant, profile, cache, scenario,
            samples: group.length,
            metrics: Object.fromEntries(metricNames.map(name => {
                const values = group.map(run => run.metrics[name]).filter(Number.isFinite);
                return [name, { median: percentile(values, 0.5), p95: percentile(values, 0.95), unit: name.endsWith('Bytes') ? 'bytes' : 'ms' }];
            })),
        };
    });
};

const formatReport = results => {
    const rows = [];
    const candidate = new Map(results.summary.filter(row => row.variant === 'candidate').map(row => [[row.profile, row.cache, row.scenario].join('|'), row]));
    for (const baseline of results.summary.filter(row => row.variant === 'baseline')) {
        const comparison = candidate.get([baseline.profile, baseline.cache, baseline.scenario].join('|'));
        for (const [metric, before] of Object.entries(baseline.metrics)) {
            const after = comparison.metrics[metric];
            const delta = before.median === 0 ? 'n/a' : `${(((after.median - before.median) / before.median) * 100).toFixed(1)}%`;
            rows.push(`| ${baseline.profile} | ${baseline.cache} | ${baseline.scenario} | ${metric} | ${before.median.toFixed(2)} | ${before.p95.toFixed(2)} | ${after.median.toFixed(2)} | ${after.p95.toFixed(2)} | ${delta} | ${before.unit} |`);
        }
    }
    const assetRows = Object.entries(results.metadata.assetSha256)
        .flatMap(([variant, assets]) => Object.entries(assets).map(([file, hash]) => `| ${variant} | \`${file}\` | \`${hash}\` |`));
    return `# PDF lazy-loading performance results\n\n` +
        `- Baseline: \`${results.metadata.baselineSha}\`\n- Candidate: \`${results.metadata.candidateSha}\`\n` +
        `- Runtime: ${results.metadata.node}; ${results.metadata.chrome}\n- Samples: ${results.metadata.samples} per variant/profile/cache/scenario\n` +
        `- Delivery: local built-in HTTP server with gzip for text assets. JavaScript bytes are Chrome encoded transfer bytes (including protocol overhead). The \`throttled\` profile uses ${PROFILES.throttled.latencyMs} ms latency, ` +
        `${PROFILES.throttled.downloadBytesPerSecond} B/s download, ${PROFILES.throttled.uploadBytesPerSecond} B/s upload, and ${PROFILES.throttled.cpuRate}x CPU throttling.\n\n` +
        `| Profile | Cache | Scenario | Metric | Before median | Before p95 | After median | After p95 | Median delta | Unit |\n` +
        `| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |\n${rows.join('\n')}\n\n` +
        `## Production asset SHA-256\n\n| Variant | Asset | SHA-256 |\n| --- | --- | --- |\n${assetRows.join('\n')}\n\n` +
        `## Limits\n\n- Chrome throttling is simulated and does not represent every device or network.\n` +
        `- Runs use synthetic PDFs (${results.metadata.fixtures.small.pages} and ${results.metadata.fixtures.large.pages} pages) and a loopback server; real documents vary.\n` +
        `- Download completion includes browser download handling. Preview milestones are observed from rendered DOM images.\n` +
        `- Bundle transfer changes alone are not treated as proof of user-visible improvement; first-use action latency is reported alongside initial rendering.\n`;
};

const main = async () => {
    const options = parseArgs();
    if (!Number.isInteger(options.samples) || options.samples < 1) throw new Error('--samples must be a positive integer');
    for (const profile of options.profiles) if (!PROFILES[profile]) throw new Error(`Unknown profile: ${profile}`);
    for (const scenario of options.scenarios) if (!ALL_SCENARIOS.includes(scenario)) throw new Error(`Unknown scenario: ${scenario}`);
    await Promise.all([stat(options.baseline), stat(options.candidate)]);

    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'pdfart-benchmark-'));
    const fixtureDirectory = path.join(temporaryDirectory, 'fixtures');
    const downloadDirectory = path.join(temporaryDirectory, 'downloads');
    await mkdir(fixtureDirectory);
    await mkdir(downloadDirectory);
    const fixtures = {
        small: { path: path.join(fixtureDirectory, 'small.pdf'), pages: 2, bytes: createPdf(2, 8) },
        large: { path: path.join(fixtureDirectory, 'large.pdf'), pages: 20, bytes: createPdf(20, 400) },
    };
    await Promise.all(Object.values(fixtures).map(fixture => writeFile(fixture.path, fixture.bytes)));

    const servers = {
        baseline: await startStaticServer(options.baseline),
        candidate: await startStaticServer(options.candidate),
    };
    const browser = await launchChrome();
    const results = {
        metadata: {
            generatedAt: new Date().toISOString(),
            baselineSha: options['baseline-sha'] ?? 'unspecified',
            candidateSha: options['candidate-sha'] ?? 'unspecified',
            baselineDirectory: options.baseline,
            candidateDirectory: options.candidate,
            node: process.version,
            chrome: execFileSync('/usr/bin/google-chrome', ['--version'], { encoding: 'utf8' }).trim(),
            samples: options.samples,
            delivery: { server: 'loopback Node HTTP', textEncoding: 'gzip', jsBytes: 'Chrome encodedDataLength including protocol overhead' },
            profiles: Object.fromEntries(options.profiles.map(name => [name, PROFILES[name]])),
            fixtures: Object.fromEntries(Object.entries(fixtures).map(([name, fixture]) => [name, { pages: fixture.pages, bytes: fixture.bytes.length }])),
            assetSha256: {
                baseline: await hashDirectory(options.baseline),
                candidate: await hashDirectory(options.candidate),
            },
        },
        runs: [],
        summary: [],
    };

    await browser.send('Page.enable');
    await browser.send('DOM.enable');
    await browser.send('Network.enable');
    await browser.send('Performance.enable');
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
        window.__benchmarkLcp = 0;
        new PerformanceObserver(list => {
            for (const entry of list.getEntries()) window.__benchmarkLcp = entry.startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
    ` });
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory });
    let activeProfile = PROFILES.local;
    let cacheDisabled = true;

    const navigate = async (url) => {
        const loaded = new Promise(resolve => {
            const off = browser.on('Page.loadEventFired', () => { off(); resolve(); });
        });
        await browser.send('Page.navigate', { url });
        await loaded;
        await browser.waitForExpression("document.querySelector('h1')?.textContent.includes('PDFart')");
    };

    const measureInitial = async (url) => {
        const page = await browser.createPage(new URL('/__benchmark_blank.html', url).href);
        try {
            await page.send('Page.enable');
            await page.send('Network.enable');
            await page.send('Performance.enable');
            await page.send('Network.setCacheDisabled', { cacheDisabled });
            await page.send('Network.emulateNetworkConditions', {
                offline: false,
                latency: activeProfile.latencyMs,
                downloadThroughput: activeProfile.downloadBytesPerSecond,
                uploadThroughput: activeProfile.uploadBytesPerSecond,
            });
            await page.send('Emulation.setCPUThrottlingRate', { rate: activeProfile.cpuRate });
            await page.waitForExpression("document.readyState === 'complete'");
            await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
                window.__benchmarkLcp = 0;
                new PerformanceObserver(list => {
                    for (const entry of list.getEntries()) window.__benchmarkLcp = entry.startTime;
                }).observe({ type: 'largest-contentful-paint', buffered: true });
            ` });
            const beforeMetrics = await page.send('Performance.getMetrics');
            const taskBefore = beforeMetrics.metrics.find(metric => metric.name === 'TaskDuration')?.value;
            if (!Number.isFinite(taskBefore)) throw new Error(`Invalid fresh-target TaskDuration baseline: ${taskBefore}`);

            const requestTypes = new Map();
            let jsTransferBytes = 0;
            page.on('Network.responseReceived', ({ requestId, type }) => requestTypes.set(requestId, type));
            page.on('Network.loadingFinished', ({ requestId, encodedDataLength }) => {
                if (requestTypes.get(requestId) === 'Script') jsTransferBytes += encodedDataLength;
            });
            const loaded = new Promise(resolve => {
                const off = page.on('Page.loadEventFired', () => { off(); resolve(); });
            });
            await page.send('Page.navigate', { url });
            await loaded;
            await page.waitForExpression("document.querySelector('h1')?.textContent.includes('PDFart')");
            await new Promise(resolve => setTimeout(resolve, 500));
            const timings = await page.evaluate(`({
                fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
                lcpMs: window.__benchmarkLcp || null
            })`);
            const afterMetrics = await page.send('Performance.getMetrics');
            const taskAfter = afterMetrics.metrics.find(metric => metric.name === 'TaskDuration')?.value;
            if (!Number.isFinite(taskAfter) || taskAfter < taskBefore) {
                throw new Error(`Fresh-target TaskDuration discontinuity: before=${taskBefore}, after=${taskAfter}`);
            }
            const metrics = { ...timings, jsTransferBytes, mainThreadTaskMs: (taskAfter - taskBefore) * 1000 };
            for (const [name, value] of Object.entries(metrics)) {
                if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid initial ${name}: ${value}`);
            }
            return metrics;
        } finally {
            await page.close();
        }
    };

    const upload = async (selector, paths) => {
        const { root } = await browser.send('DOM.getDocument');
        const { nodeId } = await browser.send('DOM.querySelector', { nodeId: root.nodeId, selector });
        if (!nodeId) throw new Error(`Missing input: ${selector}`);
        await browser.send('DOM.setFileInputFiles', { nodeId, files: paths });
    };
    const click = text => browser.evaluate(`
        [...document.querySelectorAll('button')].find(button => button.textContent.includes(${JSON.stringify(text)}))?.click()
    `);
    const setRange = value => browser.evaluate(`(() => {
        const input = document.querySelector('input[type=text]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const clearDownloads = async () => {
        await Promise.all((await readdir(downloadDirectory)).map(file => rm(path.join(downloadDirectory, file), { force: true })));
    };
    const waitForDownload = async () => {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            if ((await readdir(downloadDirectory)).some(file => !file.endsWith('.crdownload'))) return;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error('Download timed out');
    };
    const waitForPaintedImages = (selector, expectedCount) => browser.evaluate(`(async () => {
        const selector = ${JSON.stringify(selector)};
        const expectedCount = ${expectedCount};
        let images;
        do {
            await new Promise(resolve => requestAnimationFrame(resolve));
            images = [...document.querySelectorAll(selector)];
        } while (images.length !== expectedCount);
        await Promise.all(images.map(image => image.decode()));
        if (images.some(image => !image.complete || image.naturalWidth === 0)) throw new Error('Preview image did not decode');
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return performance.now() - window.__benchmarkStart;
    })()`);

    const runScenario = async (variant, scenario) => {
        const url = servers[variant].url;
        if (scenario === 'initial') return measureInitial(url);
        await navigate(url);
        const [kind, size] = scenario.split('-');
        const fixture = fixtures[size];
        if (kind === 'preview') {
            await click('추출 (Split)');
            await browser.evaluate('window.__benchmarkStart = performance.now()');
            await upload('input[type=file]:not([multiple])', [fixture.path]);
            const firstThumbnailMs = await waitForPaintedImages('img[alt="Page 1"]', 1);
            const allPreviewsMs = await waitForPaintedImages('img[alt^="Page "]', fixture.pages);
            return { firstThumbnailMs, allPreviewsMs };
        }

        await clearDownloads();
        if (kind === 'merge') {
            await upload('input[type=file][multiple]', [fixture.path, fixture.path]);
            await browser.waitForExpression("document.querySelectorAll('img[alt^=\"Preview \"]').length === 2", 30000);
            await browser.evaluate(`window.__benchmarkStart = performance.now(); [...document.querySelectorAll('button')].find(button => button.textContent.includes('병합 다운로드')).click()`);
        } else {
            await click('추출 (Split)');
            await upload('input[type=file]:not([multiple])', [fixture.path]);
            await browser.waitForExpression(`document.querySelectorAll('img[alt^="Page "]').length === ${fixture.pages}`, 30000);
            await setRange(`1-${fixture.pages}`);
            await browser.evaluate(`window.__benchmarkStart = performance.now(); [...document.querySelectorAll('button')].find(button => button.textContent.includes('추출 다운로드')).click()`);
        }
        await waitForDownload();
        return { downloadMs: await browser.evaluate('performance.now() - window.__benchmarkStart') };
    };

    try {
        for (const profileName of options.profiles) {
            const profile = PROFILES[profileName];
            activeProfile = profile;
            await browser.send('Network.emulateNetworkConditions', {
                offline: false, latency: profile.latencyMs,
                downloadThroughput: profile.downloadBytesPerSecond,
                uploadThroughput: profile.uploadBytesPerSecond,
            });
            await browser.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuRate });
            for (const cache of ['cold', 'warm']) {
                for (let sample = 1; sample <= options.samples; sample++) {
                    const variants = sample % 2 === 0 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
                    for (const variant of variants) {
                        for (const scenario of options.scenarios) {
                            if (cache === 'cold') {
                                cacheDisabled = true;
                                await browser.send('Network.setCacheDisabled', { cacheDisabled: true });
                                await browser.send('Network.clearBrowserCache');
                            } else {
                                cacheDisabled = false;
                                await browser.send('Network.setCacheDisabled', { cacheDisabled: false });
                                await browser.send('Network.clearBrowserCache');
                                await runScenario(variant, scenario);
                            }
                            const metrics = await runScenario(variant, scenario);
                            results.runs.push({ variant, profile: profileName, cache, scenario, sample, metrics });
                            results.summary = summarize(results.runs);
                            await mkdir(path.dirname(options.output), { recursive: true });
                            await writeFile(options.output, `${JSON.stringify(results, null, 2)}\n`);
                            process.stdout.write(`${variant} ${profileName} ${cache} ${scenario} ${sample}/${options.samples}\n`);
                        }
                    }
                }
            }
        }
        results.summary = summarize(results.runs);
        await writeFile(options.output, `${JSON.stringify(results, null, 2)}\n`);
        await writeFile(options.output.replace(/\.json$/i, '.md'), formatReport(results));
    } finally {
        await browser.close();
        await Promise.all(Object.values(servers).map(server => server.close()));
        await rm(temporaryDirectory, { recursive: true, force: true });
    }
};

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

