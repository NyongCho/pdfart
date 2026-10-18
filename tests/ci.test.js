import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readProjectFile = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('runs CI on pushes to main and dev, not the retired master branch', async () => {
    const workflow = await readProjectFile('.github/workflows/ci.yml');

    assert.match(workflow, /branches:\s*\[main, dev\]/);
    assert.doesNotMatch(workflow, /branches:\s*\[[^\]]*master/);
});

test('documents the current main and dev CI push branches', async () => {
    const [englishReadme, koreanReadme] = await Promise.all([
        readProjectFile('README.md'),
        readProjectFile('README.ko.md'),
    ]);

    assert.match(englishReadme, /pushes to `main` and `dev`/);
    assert.match(koreanReadme, /`main`과 `dev` push/);
    assert.doesNotMatch(englishReadme, /pushes to `master`/);
    assert.doesNotMatch(koreanReadme, /`master`와 `dev` push/);
});
