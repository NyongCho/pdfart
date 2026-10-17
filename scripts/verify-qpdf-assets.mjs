import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageRoot = path.join(root, 'node_modules/@wasm-zoo/qpdf');
const noticesRoot = path.join(root, 'public/third-party/qpdf');
const expected = {
    version: '0.1.1',
    integrity: 'sha512-smxfhQPwUYJtvfze69TXyYK4otc9femdxf+jxTf7seuuAbbbYsbVSftK9vL1m2Xfgk6PwmZmWdvlbyyz5fzfOA==',
    coreJs: '0ead3c7e15498a0af4a59008952d9e59cee847733b612eb3b25da6957ee05138',
    coreWasm: '07ced6845a714be265c4e6c5a9515e1746cc71c7f193f357b912b9f74c53b50d',
};
const noticeFiles = [
    ['LICENSE', 'LICENSE'],
    ['LICENSE.wasm-zoo.txt', 'LICENSE.wasm-zoo.txt'],
    ['LICENSES/QPDF-LICENSE.txt', 'QPDF-LICENSE.txt'],
    ['LICENSES/QPDF-NOTICE.md', 'QPDF-NOTICE.md'],
    ['LICENSES/THIRD-PARTY.txt', 'THIRD-PARTY.txt'],
    ['LICENSES/zlib-LICENSE.txt', 'zlib-LICENSE.txt'],
    ['LICENSES/libjpeg-README.txt', 'libjpeg-README.txt'],
    ['BUILDINFO.txt', 'BUILDINFO.txt'],
    ['manifest.json', 'manifest.json'],
    ['provenance.json', 'provenance.json'],
    ['sbom.cdx.json', 'sbom.cdx.json'],
];

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const projectPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const installedPackage = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const lockedPackage = lock.packages['node_modules/@wasm-zoo/qpdf'];

assert.equal(projectPackage.dependencies['@wasm-zoo/qpdf'], expected.version, 'qpdf dependency must remain exact-pinned');
assert.equal(installedPackage.version, expected.version, 'installed qpdf version changed');
assert.equal(lockedPackage.version, expected.version, 'locked qpdf version changed');
assert.equal(lockedPackage.integrity, expected.integrity, 'npm package integrity changed');
assert.equal(sha256(await readFile(path.join(packageRoot, 'qpdf-core.js'))), expected.coreJs, 'qpdf core JS hash changed');
assert.equal(sha256(await readFile(path.join(packageRoot, 'qpdf-core.wasm'))), expected.coreWasm, 'qpdf core WASM hash changed');

for (const [source, published] of noticeFiles) {
    assert.deepEqual(
        await readFile(path.join(noticesRoot, published)),
        await readFile(path.join(packageRoot, source)),
        `${published} must remain byte-identical to the pinned package`,
    );
}

try {
    const builtAssetsRoot = path.join(root, 'dist/assets');
    const builtAssets = await readdir(builtAssetsRoot);
    const builtCoreJs = builtAssets.filter(file => /^qpdf-core-.*\.js$/.test(file));
    const builtCoreWasm = builtAssets.filter(file => /^qpdf-core-.*\.wasm$/.test(file));
    assert.equal(builtCoreJs.length, 1, 'production build must emit one qpdf core JS asset');
    assert.equal(builtCoreWasm.length, 1, 'production build must emit one qpdf core WASM asset');
    assert.equal(sha256(await readFile(path.join(builtAssetsRoot, builtCoreJs[0]))), expected.coreJs, 'built qpdf core JS hash changed');
    assert.equal(sha256(await readFile(path.join(builtAssetsRoot, builtCoreWasm[0]))), expected.coreWasm, 'built qpdf core WASM hash changed');
} catch (error) {
    if (error?.code !== 'ENOENT') throw error;
}

process.stdout.write('qpdf 0.1.1 integrity, package/build core hashes, and published notices verified\n');
