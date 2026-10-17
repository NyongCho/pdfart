import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('./', import.meta.url));
const image = 'debian@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f';
const fixtures = [
  { file: 'aes128.pdf', password: 'public-AES128-pass', args: ['public-AES128-pass', 'public-owner', '128', '--use-aes=y'], revision: 'R4/AES-128' },
  { file: 'aes256-r5.pdf', password: 'public-R5-pass', args: ['public-R5-pass', 'public-owner', '256', '--force-R5'], revision: 'R5/AES-256' },
  { file: 'aes256-r6.pdf', password: 'public-R6-pass', args: ['public-R6-pass', 'public-owner', '256'], revision: 'R6/AES-256' },
  { file: 'rc4-128.pdf', password: 'public-RC4-128-pass', args: ['public-RC4-128-pass', 'public-owner', '128', '--use-aes=n'], prefix: ['--allow-weak-crypto'], revision: 'R3/RC4-128' },
  { file: 'rc4-40.pdf', password: 'public-RC4-40-pass', args: ['public-RC4-40-pass', 'public-owner', '40'], prefix: ['--allow-weak-crypto'], revision: 'R2/RC4-40' },
  { file: 'owner-only.pdf', password: '', args: ['', 'public-owner', '256', '--print=none'], revision: 'R6/AES-256 owner-only' },
  { file: 'unicode-spaces.pdf', password: '  한글 암호 🔐  ', args: ['  한글 암호 🔐  ', 'public-owner', '256'], revision: 'R6/AES-256 Unicode/leading+trailing spaces' },
];

const quoted = value => `'${value.replaceAll("'", "'\\''")}'`;
const commands = [
  'export DEBIAN_FRONTEND=noninteractive',
  'apt-get update -qq >/dev/null',
  'apt-get install -y -qq qpdf >/dev/null',
  'test "$(qpdf --version | head -n 1)" = "qpdf version 12.2.0"',
  ...fixtures.map(f => ['qpdf', ...(f.prefix ?? []), '--compress-streams=n', '--decode-level=none', '--encrypt', ...f.args, '--', 'complex-plain.pdf', f.file].map(quoted).join(' ')),
];
const version = execFileSync('docker', ['run', '--rm', '-v', `${dir}:/fixtures`, '-w', '/fixtures', image, 'sh', '-c', `qpdf --version >/dev/null 2>&1 || (apt-get update -qq >/dev/null && apt-get install -y -qq qpdf >/dev/null); qpdf --version | head -n 1; ${commands.join(' && ')}`], { encoding: 'utf8' }).trim().split('\n')[0];

const source = await readFile(`${dir}/complex-plain.pdf`);
const malformed = source.subarray(0, source.length - 18);
await writeFile(`${dir}/malformed-recoverable.pdf`, malformed);
const unsupported = Buffer.from(await readFile(`${dir}/aes128.pdf`));
const standardOffset = unsupported.indexOf(Buffer.from('/Standard'));
if (standardOffset < 0) throw new Error('AES fixture has no Standard security handler token');
Buffer.from('/PubSec  ').copy(unsupported, standardOffset);
await writeFile(`${dir}/unsupported-handler.pdf`, unsupported);

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = {
  generatedAt: '2026-10-18',
  generator: version,
  generatorImage: image,
  source: { file: 'complex-plain.pdf', sha256: digest(source) },
  fixtures: {},
};
for (const fixture of fixtures) {
  const bytes = await readFile(`${dir}/${fixture.file}`);
  manifest.fixtures[fixture.file] = { password: fixture.password, ownerPassword: 'public-owner', revision: fixture.revision, sha256: digest(bytes) };
}
manifest.controls = {
  'complex-plain.pdf': { role: 'unencrypted fidelity source', sha256: digest(source) },
  'owner-only.pdf': { role: 'encrypted permissions-only; product must detect and decline auto-unlock', password: '', ownerPassword: 'public-owner', sha256: manifest.fixtures['owner-only.pdf'].sha256 },
  'malformed-recoverable.pdf': { role: 'truncated synthetic source used to prove warning-output rejection', derivedFrom: 'complex-plain.pdf', derivation: 'remove final 18 bytes', sha256: digest(malformed) },
  'unsupported-handler.pdf': { role: 'synthetic unsupported public-key security handler token; product must reject', derivedFrom: 'aes128.pdf', derivation: 'replace first /Standard with equal-length /PubSec plus two spaces', sha256: digest(unsupported) },
  'large-encrypted.pdf': { role: 'representative-size manual evidence fixture; intentionally not stored in git', source: 'large-plain.pdf', password: 'public-large-pass', ownerPassword: 'public-owner', inputBytes: 12589949, sha256: '6d5e1d5f0e30ffe7d4887740fcf3a16229c1aff4778f7f1eca3bd78e65554ace' },
  'large-plain.pdf': { role: 'representative-size plaintext source; intentionally not stored in git', sha256: 'c001ac3a43233daf7937ea269b05e05d3f9b513c61ca9bab756961c4adfbb147' },
};
manifest.expectedContent = {
  pages: 1,
  pageSize: [420, 320],
  rotationDegrees: 0,
  text: ['PDFart unlock fidelity text', 'Second line: link, annotation, form, attachment, outline, metadata.'],
  outline: 'Synthetic outline',
  annotationKinds: ['Link', 'Text', 'Widget'],
  linkUrl: 'https://example.test/pdfart',
  form: { name: 'synthetic.name', value: 'fixture-value' },
  attachment: { name: 'fixture.txt', sha256: '803bb793ae0910ca7a045f8c49628d74495bf74ff656af10cfc909ea62ab48fb' },
  title: 'PDFart synthetic unlock fidelity fixture',
  imageOperatorPresent: true,
};
await writeFile(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
