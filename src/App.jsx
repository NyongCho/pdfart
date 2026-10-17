import React, { useState, useRef, useEffect } from 'react';
import { Upload, FileText, X, Download, ShieldCheck, Layers, Scissors, GripVertical, Eye, LockKeyhole } from 'lucide-react';
import { Github, Coffee, Heart } from 'lucide-react';
import UnlockPdfPanel from './components/UnlockPdfPanel';

function App() {
  const [mode, setMode] = useState('merge');
  const [files, setFiles] = useState([]);
  const [splitFile, setSplitFile] = useState(null);
  const [pageRange, setPageRange] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  // 미리보기 데이터 상태
  const [previews, setPreviews] = useState([]);
  const [activePreview, setActivePreview] = useState(null); // Split 모드용
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [actionError, setActionError] = useState('');

  // 드래그 앤 드롭 상태
  const [isDragging, setIsDragging] = useState(false);
  const dragItem = useRef(null);
  const dragOverItem = useRef(null);

  const [activeModal, setActiveModal] = useState(null);

  // --- 미리보기 생성 효과 (Effect) ---
  useEffect(() => {
    let ignore = false;

    const generatePreviews = async () => {
      if (mode === 'unlock') {
        setPreviews([]);
        setActivePreview(null);
        setPreviewError('');
        setIsPreviewLoading(false);
        return;
      }
      const previewFiles = mode === 'merge' ? files : splitFile ? [splitFile] : [];
      if (previewFiles.length === 0) {
        setPreviews([]);
        setActivePreview(null);
        setPreviewError('');
        setIsPreviewLoading(false);
        return;
      }

      setPreviewError('');
      setIsPreviewLoading(true);
      if (mode === 'merge') setPreviews([]);
      else setActivePreview(null);

      try {
        const { renderPdfPages } = await import('./utils/pdfRenderer');
        if (mode === 'merge') {
          // 병합 모드: 각 파일의 첫 페이지만 표지처럼 미리보기
          const newPreviews = await Promise.all(files.map(async (file) => {
            const result = await renderPdfPages(file);
            return { name: file.name, img: result.images[0]?.imgUrl };
          }));
          if (!ignore) setPreviews(newPreviews);
        } else {
          // 분할 모드: 선택된 파일의 전체 페이지 미리보기
          const result = await renderPdfPages(splitFile);
          if (!ignore) setActivePreview(result);
        }
      } catch (error) {
        if (!ignore) setPreviewError(`미리보기를 불러오지 못했습니다: ${error.message}`);
      } finally {
        if (!ignore) setIsPreviewLoading(false);
      }
    };
    generatePreviews();
    return () => { ignore = true; };
  }, [files, splitFile, mode]);

  // --- 핸들러 ---
  const handleDragOver = (e) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = () => setIsDragging(false);

  const handleDrop = (e) => {
    e.preventDefault(); setIsDragging(false);
    const droppedFiles = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');
    if (droppedFiles.length === 0) return alert("PDF 파일만 지원합니다.");
    setActionError('');
    if (mode === 'merge') setFiles(prev => [...prev, ...droppedFiles]);
    else setSplitFile(droppedFiles[0]);
  };

  const handleSortStart = (e, index) => { dragItem.current = index; };
  const handleSortEnter = (e, index) => {
    dragOverItem.current = index;
    const newFiles = [...files];
    const draggedItemContent = newFiles[dragItem.current];
    newFiles.splice(dragItem.current, 1);
    newFiles.splice(dragOverItem.current, 0, draggedItemContent);
    dragItem.current = index;
    setFiles(newFiles);
  };
  const handleSortEnd = () => { dragItem.current = null; dragOverItem.current = null; };

  const handleMergeUpload = (e) => {
    setActionError('');
    setFiles([...files, ...Array.from(e.target.files)]);
  };
  const handleSplitUpload = (e) => {
    setActionError('');
    setSplitFile(e.target.files[0]);
  };

  const executeMerge = async () => {
    if (files.length < 2) return alert("2개 이상의 파일이 필요합니다.");
    setIsProcessing(true);
    setActionError('');
    try {
      const { mergePdfs, downloadPdf } = await import('./utils/pdfManager');
      const result = await mergePdfs(files);
      downloadPdf(result, `merged-${Date.now()}.pdf`);
    } catch (e) {
      setActionError(`PDF 병합에 실패했습니다: ${e.message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const executeSplit = async () => {
    if (!splitFile || !pageRange) return alert("파일과 페이지 범위를 입력하세요.");
    setIsProcessing(true);
    setActionError('');
    try {
      const { splitPdf, downloadPdf } = await import('./utils/pdfManager');
      const result = await splitPdf(splitFile, pageRange);
      downloadPdf(result, `extracted-${Date.now()}.pdf`);
    } catch (e) {
      setActionError(`PDF 추출에 실패했습니다: ${e.message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800 font-sans p-4 md:p-8">
      <div className="max-w-7xl mx-auto"> {/* 화면 넓게 쓰기 위해 max-w 늘림 */}

        {/* 헤더 */}
        <header className="mb-8 text-center">
          <h1 className="text-4xl font-extrabold flex items-center justify-center gap-3 mb-2 text-slate-800">
            <ShieldCheck className="w-10 h-10 text-green-600" /> PDFart
          </h1>
          <p className="text-slate-500">서버 전송 없는 안전한 PDF 작업</p>
        </header>

        {/* 탭 메뉴 */}
        <div className="flex max-w-2xl mx-auto mb-8 bg-white p-2 rounded-2xl shadow-xs border border-slate-200">
          <button onClick={() => { setMode('merge'); setFiles([]); setActionError(''); }} className={`flex-1 py-3 rounded-xl font-bold text-lg flex items-center justify-center gap-2 transition-all ${mode === 'merge' ? 'bg-blue-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50'}`}>
            <Layers size={20} /> 병합 (Merge)
          </button>
          <button onClick={() => { setMode('split'); setSplitFile(null); setActionError(''); }} className={`flex-1 py-3 rounded-xl font-bold text-lg flex items-center justify-center gap-2 transition-all ${mode === 'split' ? 'bg-purple-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50'}`}>
            <Scissors size={20} /> 추출 (Split)
          </button>
          <button onClick={() => { setMode('unlock'); setActionError(''); }} className={`flex-1 py-3 rounded-xl font-bold text-sm sm:text-lg flex items-center justify-center gap-2 transition-all ${mode === 'unlock' ? 'bg-emerald-700 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50'}`}>
            <LockKeyhole size={20} /> 비밀번호 해제
          </button>
        </div>

        {/* 메인 레이아웃 (좌: 컨트롤, 우: 미리보기) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">

          {/* --- [왼쪽] 작업 영역 --- */}
          <div className="bg-white p-6 md:p-8 rounded-3xl shadow-lg border border-slate-200 min-h-[500px]">
            {mode === 'merge' ? (
              <div className="space-y-6">
                {/* Upload Zone */}
                <div className={`border-4 border-dashed rounded-3xl p-8 text-center transition-all cursor-pointer relative group ${isDragging ? 'border-blue-500 bg-blue-50' : 'border-slate-300 hover:border-blue-400 hover:bg-slate-50'}`} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
                  <input type="file" multiple accept=".pdf" onChange={handleMergeUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
                  <Upload className="mx-auto h-12 w-12 text-slate-400 mb-2" />
                  <p className="font-bold text-slate-700">여기로 PDF 드래그</p>
                </div>

                {/* File List */}
                <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                  {files.map((file, i) => (
                    <div key={i} draggable onDragStart={(e) => handleSortStart(e, i)} onDragEnter={(e) => handleSortEnter(e, i)} onDragEnd={handleSortEnd} onDragOver={(e) => e.preventDefault()} className="flex items-center bg-slate-50 p-4 rounded-xl border border-slate-200 shadow-xs cursor-grab active:cursor-grabbing hover:shadow-md transition-all">
                      <div className="mr-3 text-slate-400 cursor-grab"><GripVertical size={20} /></div>
                      <span className="w-6 h-6 bg-white rounded-full flex items-center justify-center text-xs font-bold text-slate-500 mr-3 border border-gray-200">{i + 1}</span>
                      <span className="flex-1 truncate font-medium text-slate-700">{file.name}</span>
                      <button onClick={() => { setActionError(''); setFiles(files.filter((_, idx) => idx !== i)); }} className="p-2 hover:bg-red-100 text-slate-400 hover:text-red-500 rounded-lg"><X size={20} /></button>
                    </div>
                  ))}
                  {files.length === 0 && <p className="text-center text-slate-400 py-10">파일이 없습니다.</p>}
                </div>

                {files.length > 0 && (
                  <button onClick={executeMerge} disabled={isProcessing} className="w-full py-5 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl font-bold text-xl shadow-lg transition-all flex items-center justify-center gap-2">
                    {isProcessing ? '처리 중...' : <><Download size={24} /> 병합 다운로드</>}
                  </button>
                )}
              </div>
            ) : mode === 'split' ? (
              // Split Mode UI
              <div className="space-y-6">
                <div className={`border-4 border-dashed rounded-3xl p-8 text-center transition-all cursor-pointer relative group ${isDragging ? 'border-purple-500 bg-purple-50' : 'border-slate-300 hover:border-purple-400 hover:bg-slate-50'}`} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
                  <input type="file" accept=".pdf" onChange={handleSplitUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
                  <Upload className="mx-auto h-12 w-12 text-slate-400 mb-2" />
                  <p className="font-bold text-slate-700">{splitFile ? splitFile.name : "여기로 PDF 드래그"}</p>
                </div>

                {splitFile && (
                  <div className="bg-purple-50 p-6 rounded-2xl border border-purple-100">
                    <label className="block text-lg font-bold text-slate-800 mb-2">페이지 범위</label>
                    <input type="text" placeholder="예: 1, 3, 5-10" value={pageRange} onChange={(e) => { setActionError(''); setPageRange(e.target.value); }} className="w-full p-4 text-lg border-2 border-purple-200 rounded-xl focus:border-purple-500 outline-hidden bg-white mb-4 placeholder:text-gray-400" />
                    <button onClick={executeSplit} disabled={isProcessing} className="w-full py-5 bg-purple-600 hover:bg-purple-700 text-white rounded-2xl font-bold text-xl shadow-lg transition-all flex items-center justify-center gap-2">
                      {isProcessing ? '처리 중...' : <><Download size={24} /> 추출 다운로드</>}
                    </button>
                  </div>
                )}
              </div>
            ) : <UnlockPdfPanel />}
            {actionError && <p role="alert" className="mt-4 text-sm font-medium text-red-600">{actionError}</p>}
          </div>

          {/* --- [오른쪽] 미리보기 영역 (NEW) --- */}
          <div className="bg-slate-200 p-6 md:p-8 rounded-3xl min-h-[500px] border border-slate-300 flex flex-col">
            <h2 className="text-xl font-bold text-slate-600 mb-4 flex items-center gap-2">
              {mode === 'unlock' ? <LockKeyhole className="text-emerald-700" /> : <Eye className="text-slate-500" />}
              {mode === 'unlock' ? '로컬 암호 해제 안내' : '실시간 미리보기'}
            </h2>

            <div className="flex-1 overflow-y-auto custom-scrollbar bg-slate-100 rounded-2xl p-4 shadow-inner">
              {isPreviewLoading && <p className="text-center text-slate-500 mt-20">미리보기 불러오는 중...</p>}
              {previewError && <p role="alert" className="text-center text-red-600 mt-20">{previewError}</p>}

              {/* Case 1: 병합 모드 미리보기 (표지 나열) */}
              {mode === 'merge' && !isPreviewLoading && !previewError && (
                <div className="grid grid-cols-2 gap-4">
                  {previews.map((preview, i) => (
                    <div key={i} className="bg-white p-2 rounded-lg shadow-xs group hover:shadow-md transition-all relative">
                      <div className="absolute top-2 left-2 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-bold z-10 shadow-md border-white border-2">
                        {i + 1}
                      </div>
                      {preview.img ? (
                        <img src={preview.img} alt={`Preview ${i}`} className="w-full h-auto rounded border border-slate-200" />
                      ) : (
                        <div className="w-full h-32 bg-slate-100 flex items-center justify-center text-xs text-slate-400">Loading...</div>
                      )}
                      <p className="text-xs text-center mt-2 font-medium truncate text-slate-500 px-1">{preview.name}</p>
                    </div>
                  ))}
                  {previews.length === 0 && (
                    <div className="col-span-2 text-center text-slate-400 mt-20">
                      <Layers size={48} className="mx-auto mb-2 opacity-20" />
                      <p>파일을 추가하면 여기에 순서대로 표시됩니다.</p>
                    </div>
                  )}
                </div>
              )}

              {/* Case 2: 분할 모드 미리보기 (전체 페이지 나열) */}
              {mode === 'split' && !isPreviewLoading && !previewError && (
                <div className="grid grid-cols-3 gap-3">
                  {activePreview?.images.map((img, i) => (
                    <div
                      key={i}
                      onClick={() => {
                        // 클릭 시 자동으로 input창에 페이지 추가하는 기능 (UX 센스)
                        const val = String(img.pageNumber);
                        setPageRange(prev => prev ? prev + `, ${val}` : val);
                      }}
                      className="cursor-pointer group relative"
                    >
                      <div className="bg-white p-1 rounded shadow-xs border border-slate-200 group-hover:border-purple-500 group-hover:ring-2 ring-purple-200 transition-all">
                        <img src={img.imgUrl} alt={`Page ${img.pageNumber}`} className="w-full h-auto rounded" />
                        <div className="text-center text-xs font-bold text-slate-500 mt-1">P.{img.pageNumber}</div>
                      </div>
                      {/* Hover Overlay */}
                      <div className="absolute inset-0 bg-transparent group-hover:bg-[rgba(147,51,234,0.1)] rounded transition-all flex items-center justify-center">
                        <span className="opacity-0 group-hover:opacity-100 bg-purple-600 text-white text-[10px] px-2 py-1 rounded-full font-bold shadow-xs">추가 +</span>
                      </div>
                    </div>
                  ))}
                  {!activePreview && (
                    <div className="col-span-3 text-center text-slate-400 mt-20">
                      <Scissors size={48} className="mx-auto mb-2 opacity-20" />
                      <p>파일을 선택하면 모든 페이지가 표시됩니다.</p>
                    </div>
                  )}
                </div>
              )}
              {mode === 'unlock' && (
                <div className="h-full flex flex-col items-center justify-center text-center text-slate-500 px-4">
                  <LockKeyhole size={52} className="mb-4 text-emerald-700" />
                  <p className="font-bold text-slate-700">비밀번호 해제에서는 미리보기를 제공하지 않습니다.</p>
                  <p className="mt-3 text-sm">서명된 PDF는 사본 작성 과정에서 전자서명이 무효화될 수 있습니다.</p>
                  <p className="mt-2 text-sm">50 MiB 이하 파일을 데스크톱 Chrome 검증 범위에서 처리하며, 기기 메모리가 부족하면 실패할 수 있습니다.</p>
                </div>
              )}
            </div>

            <div className="mt-4 text-center text-xs text-slate-400">
              ⚠️ 보안 알림: 미리보기 이미지는 서버로 전송되지 않고 로컬 메모리에서 생성됩니다.
            </div>
          </div>

        </div>
      </div>

      {/* footer */}
      <footer className="mt-20 border-t border-slate-200 py-10 text-center">
        <div className="max-w-4xl mx-auto px-4">

          {/* 1. 서비스 한줄 소개 & 보안 강조 */}
          <div className="flex flex-col items-center justify-center gap-2 mb-6">
            <p className="text-slate-600 font-medium">
              PDFart은 사용자의 파일을 서버로 전송하지 않습니다.
            </p>
            <p className="text-slate-400 text-sm">
              모든 작업은 브라우저(Client-side) 내에서 안전하게 처리됩니다.
            </p>
          </div>

          {/* 2. 링크 버튼들 (GitHub, 후원) */}
          <div className="flex items-center justify-center gap-4 mb-8">
            {/* 깃허브 버튼 */}
            <a
              href="https://github.com/nyongcho/pdfart"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 px-4 py-2 bg-slate-800 text-white rounded-lg hover:bg-slate-700 transition-all text-sm font-bold"
            >
              <Github size={18} /> Source Code
            </a>

            {/* 후원 버튼 (커피) */}
            <a
              href="https://buymeacoffee.com/nyongcho"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 px-4 py-2 bg-yellow-400 text-slate-900 rounded-lg hover:bg-yellow-300 transition-all text-sm font-bold shadow-xs"
            >
              <Coffee size={18} /> Buy me a coffee
            </a>
          </div>

          {/* 3. 하단 저작권 & 약관 */}
          <div className="text-slate-400 text-xs flex flex-col md:flex-row items-center justify-center gap-4">
            <span>© 2026 Pdfart. All rights reserved.</span>
            <span className="hidden md:inline">|</span>
            <div className="flex gap-4">
              {/* ▼▼▼ 여기를 수정하세요 (a 태그 -> button 태그 및 onClick 추가) ▼▼▼ */}
              <button
                onClick={() => setActiveModal('terms')}
                className="hover:text-slate-600 underline"
              >
                이용약관
              </button>
              <button
                onClick={() => setActiveModal('privacy')}
                className="hover:text-slate-600 underline font-bold"
              >
                개인정보처리방침
              </button>
              {/* 이메일 링크는 mailto: 를 붙여야 메일앱이 열립니다 */}
              <a
                href="mailto:juneyong87@gmail.com"
                className="hover:text-slate-600 underline"
              >
                문의하기
              </a>
            </div>
          </div>

          <div className="mt-4 text-slate-300 flex items-center justify-center gap-1 text-xs">
            Made with <Heart size={12} className="text-red-400 fill-red-400" /> by You
          </div>
        </div>
      </footer>

      {/* ▼▼▼ 법적 고지 모달 (팝업) ▼▼▼ */}
      {activeModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-xs" onClick={() => setActiveModal(null)}>
          <div className="bg-white rounded-2xl max-w-lg w-full p-8 shadow-2xl relative" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setActiveModal(null)} className="absolute top-4 right-4 text-slate-400 hover:text-slate-600"><X size={24} /></button>

            {activeModal === 'terms' && (
              <div>
                <h3 className="text-2xl font-bold mb-4 flex items-center gap-2">📜 이용약관</h3>
                <div className="text-sm text-slate-600 space-y-3 h-[300px] overflow-y-auto custom-scrollbar p-2 bg-slate-50 rounded-xl">
                  <p><strong>제1조 (목적)</strong><br />본 약관은 Pdfart(이하 "서비스")의 이용 조건 및 절차를 규정합니다.</p>
                  <p><strong>제2조 (서비스의 성격)</strong><br />본 서비스는 사용자의 브라우저 내에서 작동하는 클라이언트 사이드 도구이며, 별도의 서버로 파일을 전송하거나 저장하지 않습니다.</p>
                  <p><strong>제3조 (책임의 제한)</strong><br />1. 본 서비스는 "있는 그대로(As-Is)" 제공됩니다.<br />2. 사용자가 본 서비스를 이용하여 처리한 파일의 손상이나 데이터 손실에 대해 서비스 제공자는 책임을 지지 않습니다. 중요한 문서는 반드시 백업하시기 바랍니다.</p>
                  <p><strong>제4조 (비용)</strong><br />본 서비스는 기본적으로 무료로 제공됩니다.</p>
                </div>
              </div>
            )}

            {activeModal === 'privacy' && (
              <div>
                <h3 className="text-2xl font-bold mb-4 flex items-center gap-2">🔒 개인정보처리방침</h3>
                <div className="text-sm text-slate-600 space-y-3 h-[300px] overflow-y-auto custom-scrollbar p-2 bg-slate-50 rounded-xl">
                  <p className="bg-green-100 text-green-800 p-3 rounded-lg font-bold border border-green-200">
                    요약: Pdfart는 귀하의 파일을 절대 수집하지 않습니다.
                  </p>
                  <p><strong>1. 수집하는 개인정보 항목</strong><br />본 서비스는 회원가입 기능이 없으며, 사용자의 이름, 연락처, 파일 등 어떠한 개인정보도 서버로 전송하거나 수집하지 않습니다.</p>
                  <p><strong>2. 파일 처리 방식</strong><br />모든 PDF 파일 처리는 사용자의 기기(PC/스마트폰) 브라우저 메모리 내에서 WebAssembly 기술을 통해 이루어집니다. 업로드 과정은 존재하지 않습니다.</p>
                  <p><strong>3. 쿠키 사용</strong><br />본 서비스는 사용자 추적을 위한 쿠키를 사용하지 않습니다.</p>
                  <p><strong>4. 문의처</strong><br />보안 관련 문의는 하단의 이메일을 이용해 주시기 바랍니다.</p>
                </div>
              </div>
            )}

            <button onClick={() => setActiveModal(null)} className="w-full mt-6 py-3 bg-slate-800 text-white rounded-xl font-bold hover:bg-slate-700">확인했습니다</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
