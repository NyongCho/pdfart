import * as pdfjsLib from 'pdfjs-dist';

// [수정된 부분] 외부 CDN(unpkg) 대신 로컬 node_modules에 있는 worker를 가져옵니다.
// '?url'은 Vite에서 파일을 URL 경로로 가져오는 문법입니다.
import pdfWorker from 'pdfjs-dist/build/pdf.worker?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

/**
 * PDF 파일의 페이지들을 이미지 데이터(DataURL) 배열로 변환
 */
export const renderPdfPages = async (file) => {
    const arrayBuffer = await file.arrayBuffer();

    // 문서 로드
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;

    const totalPages = pdf.numPages;
    const images = [];

    // 성능을 위해 최대 20페이지만 미리보기
    const maxPreview = Math.min(totalPages, 20);

    for (let i = 1; i <= maxPreview; i++) {
        const page = await pdf.getPage(i);

        // 썸네일 크기 설정 (화질 개선을 위해 scale을 0.3 -> 0.5 정도로 조정)
        const viewport = page.getViewport({ scale: 0.5 });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        await page.render({ canvasContext: context, viewport: viewport }).promise;

        images.push({
            pageNumber: i,
            imgUrl: canvas.toDataURL()
        });
    }

    return { totalPages, images };
};