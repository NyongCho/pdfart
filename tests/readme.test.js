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

test('shows captioned merge and password-unlock previews in both READMEs', async () => {
    const readmes = await readReadmes();

    for (const readme of readmes) {
        assert.match(readme, /!\[[^\]]{20,}\]\(\.\/screenshot\.png\)\n\n\*[^*]+\*/);
        assert.match(readme, /!\[[^\]]{20,}\]\(\.\/docs\/images\/pdf-unlock\.png\)\n\n\*[^*]+\*/);
        assert.doesNotMatch(readme, /!\[Screenshot\]/);
    }
});
