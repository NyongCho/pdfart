import { PDFDocument, StandardFonts, rgb, PDFName, PDFString } from 'pdf-lib';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const outDir = new URL('./', import.meta.url);
await mkdir(outDir, { recursive: true });

const pdf = await PDFDocument.create();
pdf.setTitle('PDFart synthetic unlock fidelity fixture');
pdf.setAuthor('PDFart probe');
pdf.setSubject('Synthetic public test data');
pdf.setKeywords(['pdfart', 'unlock', 'synthetic']);
pdf.setProducer('pdf-lib 1.17.1');
pdf.setCreator('PDFart Task B probe');

const font = await pdf.embedFont(StandardFonts.Helvetica);
const page = pdf.addPage([420, 320]);
page.setRotation({ type: 'degrees', angle: 0 });
page.drawText('PDFart unlock fidelity text', { x: 40, y: 270, size: 18, font });
page.drawText('Second line: link, annotation, form, attachment, outline, metadata.', { x: 40, y: 245, size: 9, font });

const png = await pdf.embedPng(Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DAwMDAxAADCBYAG10BBdmzc7oAAAAASUVORK5CYII=',
  'base64',
)));
page.drawImage(png, { x: 40, y: 170, width: 48, height: 48 });

const link = pdf.context.obj({
  Type: 'Annot', Subtype: 'Link', Rect: [40, 220, 220, 240], Border: [0, 0, 0],
  A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.test/pdfart') },
});
const note = pdf.context.obj({
  Type: 'Annot', Subtype: 'Text', Rect: [250, 220, 275, 245],
  Contents: PDFString.of('Synthetic annotation'), Name: 'Comment',
});
const linkRef = pdf.context.register(link);
const noteRef = pdf.context.register(note);
page.node.set(PDFName.of('Annots'), pdf.context.obj([linkRef, noteRef]));

const form = pdf.getForm();
const field = form.createTextField('synthetic.name');
field.setText('fixture-value');
field.addToPage(page, { x: 40, y: 110, width: 180, height: 28, textColor: rgb(0, 0, 0) });

await pdf.attach(Uint8Array.from(Buffer.from('synthetic attachment contents\n')), 'fixture.txt', {
  mimeType: 'text/plain', description: 'Synthetic attachment', creationDate: new Date('2026-10-18T00:00:00Z'),
});

const outlineItem = pdf.context.obj({
  Title: PDFString.of('Synthetic outline'), Parent: null, Dest: [page.ref, 'Fit'],
});
const outlineItemRef = pdf.context.register(outlineItem);
const outlines = pdf.context.obj({ Type: 'Outlines', First: outlineItemRef, Last: outlineItemRef, Count: 1 });
const outlinesRef = pdf.context.register(outlines);
outlineItem.set(PDFName.of('Parent'), outlinesRef);
pdf.catalog.set(PDFName.of('Outlines'), outlinesRef);

const bytes = await pdf.save({ useObjectStreams: false });
await writeFile(new URL('complex-plain.pdf', outDir), bytes);
await writeFile(new URL('plain-sha256.txt', outDir), `${createHash('sha256').update(bytes).digest('hex')}  complex-plain.pdf\n`);
