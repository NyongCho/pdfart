import { PDFDocument } from 'pdf-lib';

// PDF 병합 함수
export const mergePdfs = async (files) => {
    const mergedPdf = await PDFDocument.create();

    for (const file of files) {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await PDFDocument.load(arrayBuffer);
        const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
        copiedPages.forEach((page) => mergedPdf.addPage(page));
    }

    return await mergedPdf.save();
};

// PDF 분할 함수
export const splitPdf = async (file, pageRangeString) => {
    const arrayBuffer = await file.arrayBuffer();
    const srcPdf = await PDFDocument.load(arrayBuffer);
    const newPdf = await PDFDocument.create();
    const totalPages = srcPdf.getPageCount();

    const pageIndices = parsePageRange(pageRangeString, totalPages);

    if (pageIndices.length === 0) throw new Error("유효한 페이지 번호가 없습니다.");

    const copiedPages = await newPdf.copyPages(srcPdf, pageIndices);
    copiedPages.forEach((page) => newPdf.addPage(page));

    return await newPdf.save();
};

// 페이지 범위 파싱 헬퍼 함수
const parsePageRange = (rangeStr, maxPages) => {
    const pages = new Set();
    const parts = rangeStr.split(',').map(s => s.trim());

    parts.forEach(part => {
        if (!/^\d+(?:\s*-\s*\d+)?$/.test(part)) return;

        if (part.includes('-')) {
            const [start, end] = part.split('-').map(Number);
            if (Number.isSafeInteger(start) && Number.isSafeInteger(end)) {
                for (let i = Math.max(1, start); i <= Math.min(end, maxPages); i++) pages.add(i - 1);
            }
        } else {
            const num = Number(part);
            if (Number.isSafeInteger(num)) pages.add(num - 1);
        }
    });

    return Array.from(pages).filter(p => p >= 0 && p < maxPages).sort((a, b) => a - b);
};

// 다운로드 함수
export const downloadPdf = (data, filename) => {
    const blob = new Blob([data], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
};
