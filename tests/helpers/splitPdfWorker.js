import { File } from 'node:buffer';
import { parentPort, workerData } from 'node:worker_threads';
import { PDFDocument } from 'pdf-lib';
import { splitPdf } from '../../src/utils/pdfManager.js';

const file = new File([workerData.bytes], 'input.pdf', { type: 'application/pdf' });
const result = await splitPdf(file, workerData.range);
const pdf = await PDFDocument.load(result);
parentPort.postMessage(pdf.getPages().map(page => page.getWidth()));
