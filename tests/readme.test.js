import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readProjectFile = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const readReadmes = () => Promise.all([
    readProjectFile('README.md'),
    readProjectFile('README.ko.md'),
]);

test('documents a directly copyable clone command in both READMEs', async () => {
    const readmes = await readReadmes();

    for (const readme of readmes) {
        assert.match(readme, /^git clone https:\/\/github\.com\/NyongCho\/pdfart\.git$/m);
        assert.doesNotMatch(readme, /^git clone .*\[[^\]]+\]\([^)]+\)/m);
    }
});

test('shows only the default main screen in both README Preview sections', async () => {
    const cases = [
        { readme: await readProjectFile('README.md'), alt: 'Pdfart main screen' },
        { readme: await readProjectFile('README.ko.md'), alt: 'Pdfart 기본 화면' },
    ];

    for (const { readme, alt } of cases) {
        const preview = readme.match(/## 📸 Preview\n\n([\s\S]*?)\n\n## /)?.[1];
        assert.ok(preview);
        assert.equal(preview, `![${alt}](./screenshot.png)`);
        assert.doesNotMatch(readme, /docs\/images\/pdf-unlock\.png/);
    }
});
