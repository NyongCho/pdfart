<div align="center">

[![Language](https://img.shields.io/badge/lang-English-blue.svg)](./README.md)
[![Language](https://img.shields.io/badge/언어-한국어-red.svg)](./README.ko.md)

# 🛡️ Pdfart (Private PDF Tool)

> **"Your files never leave your browser."**
>
> **Pdfart**는 서버로 파일을 전송하지 않고, 사용자의 브라우저(Client-side) 내에서 100% 안전하게 작동하는 PDF 편집 도구입니다.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![React](https://img.shields.io/badge/react-%2320232a.svg?style=flat&logo=react&logoColor=%2361DAFB)
![Vite](https://img.shields.io/badge/vite-%23646CFF.svg?style=flat&logo=vite&logoColor=white)
![TailwindCSS](https://img.shields.io/badge/tailwindcss-%2338B2AC.svg?style=flat&logo=tailwind-css&logoColor=white)

</div>

---

## 📸 Preview

![Screenshot](./screenshot.png)

## ✨ 주요 기능 (Key Features)

### 1. 🔒 철통 보안 (Privacy First)
- **Serverless:** 백엔드 서버가 없습니다. 모든 연산은 사용자의 PC 메모리에서 WebAssembly와 JavaScript로 처리됩니다.
- **No Uploads:** 민감한 개인정보(여권, 계약서 등)가 외부로 유출될 걱정이 없습니다.

### 2. 📑 PDF 병합 (Merge)
- **드래그 앤 드롭:** 여러 개의 PDF 파일을 손쉽게 추가할 수 있습니다.
- **순서 변경:** 마우스로 파일 목록을 드래그하여 병합 순서를 직관적으로 바꿀 수 있습니다.
- **실시간 미리보기:** 파일의 표지를 우측 패널에서 즉시 확인할 수 있습니다.

### 3. ✂️ 페이지 추출 (Split)
- **페이지 선택:** 특정 페이지만 쏙 뽑아내어 새로운 PDF로 저장합니다.
- **클릭 투 애드 (Click-to-Add):** 우측 미리보기에서 원하는 페이지 이미지를 클릭하면 자동으로 번호가 입력됩니다.
- **범위 지정:** `1, 3, 5-10`과 같이 유연한 페이지 범위 입력을 지원합니다.

### 4. 🔓 알고 있는 PDF 비밀번호 해제
- 암호화된 PDF 한 개와 사용자가 알고 있는 열기 비밀번호를 입력하면 암호 없는
  사본을 내려받습니다. 원본은 변경하지 않습니다.
- 파일과 비밀번호는 브라우저 메모리에서만 다루며 URL, 브라우저 저장소,
  분석 이벤트, 서버 요청에 넣지 않습니다.
- 50 MiB, 동시 작업 1개, 엔진 로드를 포함한 전체 60초 제한이 있습니다.
  서명 문서는 사본 작성으로 전자서명이 무효화될 수 있습니다. 비밀번호 찾기나
  악성 PDF 정화 기능이 아니며, 비정상적으로 압축된 입력은 기기 메모리를
  소진할 수 있습니다.
- 검증 범위는 [엔진/보안 기록](./docs/pdf-unlock-security.md)의 데스크톱 Chrome
  및 암호화 fixture 표이며 모든 브라우저를 보장하지 않습니다.

### 5. 🚀 최신 웹 기술
- **Fast:** React + Vite 기반의 즉각적인 반응 속도.
- **Clean UI:** Tailwind CSS를 활용한 모던하고 직관적인 디자인.

---

## 🛠️ 기술 스택 (Tech Stack)

이 프로젝트는 다음의 오픈소스 라이브러리들을 사용하여 제작되었습니다.

- **Frontend Framework:** [React](https://react.dev/) + [Vite](https://vitejs.dev/)
- **Styling:** [Tailwind CSS](https://tailwindcss.com/)
- **PDF Core Logic:** [pdf-lib](https://pdf-lib.js.org/) (PDF 생성 및 수정)
- **PDF Rendering:** [pdfjs-dist](https://github.com/mozilla/pdf.js) (미리보기 이미지 생성)
- **PDF Unlocking:** 앱 소유 Worker에서 exact pin된 `@wasm-zoo/qpdf@0.1.1`
  raw asset(QPDF 12.4.2)을 사용합니다. [고지와 보안 한계](./docs/pdf-unlock-security.md).
- **Icons:** [Lucide React](https://lucide.dev/)
- **Drag & Drop:** Native HTML5 Drag and Drop API

---

## 🚀 설치 및 실행 방법 (Getting Started)

CI 환경과 동일하게 Node.js 24를 사용하세요.

Tailwind CSS 4가 생성한 CSS의 최소 요구 버전은 Safari 16.4+, Chrome 111+,
Firefox 128+입니다. 이는 앱 전체의 검증된 브라우저 지원 범위를 의미하지 않습니다.

```bash
# 1. 저장소 복제 (Clone)
git clone [https://github.com/nyongcho/pdfart.git](https://github.com/nyongcho/pdfart.git)
cd pdfart

# 2. 패키지 설치
npm install

# 3. 개발 서버 실행
npm run dev
```

## 검증 및 CI

```bash
npm ci
npm run lint
npm test
npm run build
npm run verify:engine
```

GitHub Actions가 PR과 `main`과 `dev` push에서 위 검증을 실행합니다.
기존 Vercel 배포는 변경하지 않으며, 이 워크플로만으로 배포 차단이나
PR 필수 검사 설정이 적용되지는 않습니다.

테스트는 Node 내장 테스트 러너와 메모리에서 생성한 실제 PDF를 사용합니다.
병합 순서, 페이지 추출, 중복 선택, 잘못된 입력 및 큰 페이지 범위를 검증합니다.
페이지는 십진 정수로 지정하며, 중복을 제거하고 원본 문서 순서로 정렬합니다.
범위는 실제 페이지 안으로 제한하고 잘못된 토큰은 무시합니다.
유효한 페이지가 하나도 없으면 오류를 반환합니다.
