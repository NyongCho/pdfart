import { Download, Eye, EyeOff, LockKeyhole, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { abortable } from '../utils/abortable';

const MAX_BYTES = 50 * 1024 * 1024;
const OPERATION_TIMEOUT_MS = 60_000;

const ERROR_MESSAGES = {
  EMPTY_FILE: '빈 파일은 처리할 수 없습니다.',
  FILE_TOO_LARGE: '파일은 50 MiB 이하여야 합니다.',
  PASSWORD_REQUIRED: 'PDF 열기 비밀번호를 입력하세요.',
  INVALID_PASSWORD_CHARACTER: '비밀번호에는 NUL 문자를 사용할 수 없습니다.',
  INVALID_PASSWORD: '비밀번호가 올바르지 않습니다. 다시 입력해 주세요.',
  UNENCRYPTED_PDF: '이미 비밀번호가 없는 PDF입니다.',
  PERMISSIONS_ONLY: '비밀번호 없이 열리는 권한 제한 문서는 자동 해제하지 않습니다.',
  INVALID_PDF: '손상되었거나 올바른 PDF가 아닙니다.',
  UNSUPPORTED_ENCRYPTION: '지원하지 않는 PDF 암호화 방식입니다.',
  WARNING_OUTPUT_REJECTED: '문서 경고가 발생해 안전하게 결과를 만들지 않았습니다.',
  ENGINE_LOAD_FAILED: '암호 해제 엔진을 불러오지 못했습니다. 다시 시도해 주세요.',
  WORKER_UNSUPPORTED: '이 브라우저에서는 로컬 암호 해제를 지원하지 않습니다.',
  TIMEOUT: '60초 안에 처리가 끝나지 않아 중단했습니다.',
  ABORTED: '암호 해제를 취소했습니다.',
  JOB_IN_PROGRESS: '이미 암호 해제 작업을 처리하고 있습니다.',
  WORKER_CRASH: '암호 해제 작업이 중단되었습니다. 다시 시도해 주세요.',
  WORKER_MESSAGE_ERROR: '암호 해제 결과를 읽지 못했습니다. 다시 시도해 주세요.',
  PROCESSING_FAILED: 'PDF 암호 해제에 실패했습니다. 파일과 비밀번호를 확인해 주세요.',
};

const formatSize = bytes => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const outputName = name => `${name.replace(/\.pdf$/i, '') || 'document'}-unlocked.pdf`;

function UnlockPdfPanel() {
  const [file, setFile] = useState(null);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const controllerRef = useRef(null);
  const jobRef = useRef(0);

  const cancelCurrent = (showMessage = true) => {
    jobRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setPassword('');
    setShowPassword(false);
    setStatus('idle');
    if (showMessage) setError(ERROR_MESSAGES.ABORTED);
  };

  useEffect(() => () => {
    jobRef.current += 1;
    controllerRef.current?.abort();
  }, []);

  const selectFile = nextFile => {
    if (controllerRef.current) cancelCurrent(false);
    setError('');
    setPassword('');
    setShowPassword(false);
    setFile(null);
    setStatus('idle');
    if (!nextFile) return setFile(null);
    if (nextFile.size === 0) return setError(ERROR_MESSAGES.EMPTY_FILE);
    if (nextFile.size > MAX_BYTES) return setError(ERROR_MESSAGES.FILE_TOO_LARGE);
    setFile(nextFile);
  };

  const handleFiles = selected => {
    if (controllerRef.current) cancelCurrent(false);
    setFile(null);
    setPassword('');
    setShowPassword(false);
    setStatus('idle');
    if (selected.length !== 1) {
      setError('PDF 파일을 한 개만 선택해 주세요.');
      return;
    }
    selectFile(selected[0]);
  };

  const execute = async () => {
    if (!file) return setError('암호화된 PDF 파일을 선택하세요.');
    if (password.length === 0) return setError(ERROR_MESSAGES.PASSWORD_REQUIRED);
    if (status === 'processing') return;

    const job = ++jobRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    const startedAt = performance.now();
    const deadline = setTimeout(() => controller.abort(), OPERATION_TIMEOUT_MS);
    setStatus('processing');
    setError('');

    try {
      const imports = await abortable(Promise.all([
          import('../utils/pdfUnlocker'),
          import('../utils/pdfDownload'),
        ]), controller.signal, () => Object.assign(new Error('deadline'), { code: 'TIMEOUT' }));
      const [{ unlockPdf }, { downloadPdf }] = imports;
      const remaining = Math.max(1, OPERATION_TIMEOUT_MS - (performance.now() - startedAt));
      const output = await unlockPdf(file, password, { signal: controller.signal, timeoutMs: remaining });
      if (job !== jobRef.current || controller.signal.aborted) return;
      downloadPdf(output, outputName(file.name));
      setStatus('success');
    } catch (caught) {
      if (job !== jobRef.current) return;
      const code = controller.signal.aborted ? 'TIMEOUT' : caught?.code;
      setError(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.PROCESSING_FAILED);
      setStatus('idle');
    } finally {
      clearTimeout(deadline);
      if (job === jobRef.current) {
        controllerRef.current = null;
        setPassword('');
        setShowPassword(false);
      }
    }
  };

  return (
    <div className="space-y-6">
      <div
        className="border-4 border-dashed rounded-3xl p-8 text-center transition-all relative bg-emerald-50 border-emerald-300"
        onDragOver={event => event.preventDefault()}
        onDrop={event => { event.preventDefault(); handleFiles(Array.from(event.dataTransfer.files)); }}
      >
        <input
          data-mode="unlock"
          aria-label="암호화된 PDF 선택"
          type="file"
          accept=".pdf,application/pdf"
          onChange={event => handleFiles(Array.from(event.target.files))}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
        <Upload className="mx-auto h-12 w-12 text-emerald-600 mb-2" />
        <p className="font-bold text-slate-700">{file ? file.name : '암호화된 PDF 한 개 선택'}</p>
        {file && <p className="text-sm text-slate-500 mt-1">{formatSize(file.size)} · 브라우저에서만 처리</p>}
      </div>

      {file && (
        <div className="bg-emerald-50 p-5 rounded-2xl border border-emerald-200 space-y-4">
          <div>
            <label htmlFor="unlock-password" className="block font-bold text-slate-800 mb-2">PDF 열기 비밀번호</label>
            <div className="flex gap-2">
              <input
                id="unlock-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={event => { setPassword(event.target.value); setError(''); }}
                onBeforeInput={event => {
                  if (/[\r\n]/.test(event.data ?? '')) {
                    event.preventDefault();
                    setError('줄바꿈이 포함된 비밀번호는 이 입력창에서 지원하지 않습니다.');
                  }
                }}
                onPaste={event => {
                  if (/[\r\n]/.test(event.clipboardData.getData('text'))) {
                    event.preventDefault();
                    setError('줄바꿈이 포함된 비밀번호는 이 입력창에서 지원하지 않습니다.');
                  }
                }}
                autoComplete="off"
                spellCheck={false}
                disabled={status === 'processing'}
                className="min-w-0 flex-1 p-3 border-2 border-emerald-200 rounded-xl focus:border-emerald-600 outline-hidden bg-white"
              />
              <button
                type="button"
                aria-label={showPassword ? '비밀번호 숨기기' : '비밀번호 표시'}
                onClick={() => setShowPassword(value => !value)}
                className="shrink-0 px-4 rounded-xl border border-emerald-300 bg-white text-emerald-800"
              >
                {showPassword ? <EyeOff /> : <Eye />}
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-500">공백을 포함해 입력 그대로 사용합니다. 자동완성 차단은 브라우저에 대한 힌트입니다.</p>
          </div>

          {status === 'processing' ? (
            <button type="button" onClick={() => cancelCurrent(true)} className="w-full py-4 bg-slate-700 text-white rounded-2xl font-bold flex items-center justify-center gap-2">
              <X size={20} /> 취소
            </button>
          ) : (
            <button type="button" onClick={execute} className="w-full py-4 bg-emerald-700 hover:bg-emerald-800 text-white rounded-2xl font-bold flex items-center justify-center gap-2">
              <Download size={22} /> 비밀번호 해제 다운로드
            </button>
          )}
        </div>
      )}

      <div aria-live="polite" className="text-sm text-slate-600 flex items-center gap-2">
        <LockKeyhole size={18} />
        {status === 'processing' ? '로컬에서 처리 중입니다…' : status === 'success' ? '암호 없는 사본을 다운로드했습니다.' : '파일과 비밀번호는 서버·URL·저장소로 보내거나 저장하지 않습니다.'}
      </div>
      {error && <p role="alert" className="text-sm font-medium text-red-600">{error}</p>}
    </div>
  );
}

export default UnlockPdfPanel;
