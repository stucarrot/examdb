/* answerSheetImport.js — "정답 일괄 입력" 모달에서 정답표(표 형식 PDF/이미지)를
 * 첨부하면 그 안에서 선택한 문제지의 과목명/책형에 해당하는 행을 찾아
 * 문제번호별 정답을 자동으로 읽어와 텍스트 영역을 채워주는 기능.
 *
 * 대상 형식: 국가공무원 5·7급 등에서 흔히 배포되는 "연번 | 과목명 | 책형 |
 * 1번 2번 3번 …" 형태의 표. 같은 과목이 책형별로 여러 줄(행)에 걸쳐 있을 수
 * 있고(책형만 다르고 과목명 칸은 비어있는 이어지는 행), 첫 줄에만 연번/
 * 과목명이 적혀 있다.
 *
 * 파이프라인:
 *   1) PDF면 pdf.js로 텍스트 레이어만 읽어 줄(라인) 단위 문자열 배열로
 *      재구성한다(좌표 기반 — 렌더링은 하지 않아 빠름).
 *      이미지면 Tesseract.js(CDN, 최초 사용 시에만 지연 로드)로 OCR한다.
 *   2) 줄들을 순서대로 훑으며 상태머신으로 "과목 시작 행" / "이어지는 책형
 *      행" / "그 외(제목·머리말 등, 무시)"로 분류해 {subject, round,
 *      answers[]} 목록으로 만든다.
 *   3) 현재 선택된 문제지의 과목명/책형과 매칭해서 자동으로(또는 후보가
 *      여러 개면 사용자가 골라서) "문제번호 정답" 텍스트를 만들어 기존
 *      정답 일괄 입력 텍스트영역에 채워준다. 실제 저장은 기존 "적용" 버튼
 *      로직(library.js의 applyBulkAnswers)이 그대로 담당 — 이 모듈은 텍스트
 *      영역을 채우는 데까지만 관여해서, 사용자가 항상 결과를 눈으로 확인/
 *      수정한 뒤 적용하게 한다.
 */

const AnswerSheetImport = (() => {
  const CIRCLED_TO_DIGIT = { '①': '1', '②': '2', '③': '3', '④': '4', '⑤': '5', '⑥': '6', '⑦': '7', '⑧': '8', '⑨': '9' };
  const ROUND_TOKENS = new Set(['A', 'B', 'C', 'D', 'E', '가', '나', '다', '라', '마']);
  // "책형" 열에서 항상 가장 먼저 나오는 책형(그 표에서 새 과목이 시작될 때
  // 등장). 국가공무원 5·7급 정답표는 거의 항상 '가'(드물게 'A')로 시작한다.
  // 이 값을 만나면 "새 과목 블록 시작"으로 보고, 그 외(나/다/라/마 등)는
  // "직전과 같은 과목의 이어지는 책형"으로 본다 — 아래 parseAnswerTableLines의
  // "연번+과목명이 별도 줄로 떨어지는 표 형식" 처리에서 과목 경계를 판단하는
  // 데 사용.
  const FIRST_ROUND_TOKENS = new Set(['가', 'A']);
  let lastCandidateList = [];

  function el(sel, root = document) { return root.querySelector(sel); }

  function init() {
    const analyzeBtn = el('#bulkAnswerSheetAnalyze');
    const useBtn = el('#bulkAnswerSheetUseCandidate');
    if (!analyzeBtn) return; // 모달 마크업이 없는 페이지에서는 조용히 스킵
    analyzeBtn.addEventListener('click', onAnalyzeClick);
    useBtn.addEventListener('click', () => {
      const idx = parseInt(el('#bulkAnswerSheetCandidates').value, 10);
      const row = lastCandidateList[idx];
      if (row) fillFromRow(row);
    });
  }

  function resetUI() {
    el('#bulkAnswerSheetCandidateWrap').classList.add('hidden');
    el('#bulkAnswerSheetStatus').textContent = '';
    lastCandidateList = [];
  }

  async function onAnalyzeClick() {
    const statusEl = el('#bulkAnswerSheetStatus');
    const fileInput = el('#bulkAnswerSheetFile');
    const file = fileInput.files && fileInput.files[0];
    const examId = el('#bulkAnswerExam').value;
    resetUI();

    if (!examId) { statusEl.textContent = '먼저 위에서 문제지를 선택해주세요.'; return; }
    if (!file) { statusEl.textContent = '정답표 파일(PDF 또는 이미지)을 선택해주세요.'; return; }

    const exam = await DB.getExam(examId);
    if (!exam) { statusEl.textContent = '문제지 정보를 불러오지 못했습니다.'; return; }

    statusEl.textContent = '정답표 분석 중…';
    try {
      const { rows, answerCount } = await analyzeFile(file);
      if (!rows.length) {
        statusEl.textContent = '정답표에서 표를 인식하지 못했습니다. (PDF는 텍스트 선택이 가능한 파일인지, 이미지는 표가 선명한지 확인해주세요)';
        return;
      }

      let candidates = findSubjectCandidates(rows, exam.subject);
      let note = '';
      if (!candidates.length) {
        candidates = rows;
        // 정답표에 과목이 딱 한 줄만 인식됐다면(예: 캡처 이미지 형태의
        // 단일 과목 "문제/정답" 표) 과목명 매칭 실패 여부와 무관하게
        // 굳이 선택창을 띄우지 않고 그대로 사용한다 — 애초에 고를
        // 후보가 하나뿐이라 선택 UI가 의미 없기 때문. 여러 줄이 인식된
        // 다과목 표에서만 안내 문구와 함께 후보 선택을 요구한다.
        if (rows.length !== 1) {
          note = `"${exam.subject || '(과목명 미입력)'}"과 일치하는 과목명을 찾지 못했습니다. 아래 전체 목록(${rows.length}개)에서 직접 선택해주세요.`;
        }
      } else if (exam.round) {
        const roundFiltered = candidates.filter((r) => roundsMatch(r.round, exam.round));
        if (roundFiltered.length) candidates = roundFiltered;
      }

      if (!note && candidates.length === 1) {
        const row = candidates[0];
        fillFromRow(row);
        const filled = row.answers.filter((a) => a !== undefined && a !== '').length;
        statusEl.textContent = `자동 인식 완료: ${row.subject || exam.subject || '(과목명 미상)'} · ${row.round || exam.round || '책형 미상'}책형 (${filled}/${answerCount}문항 인식)`;
        return;
      }

      lastCandidateList = candidates;
      populateCandidateSelect(candidates, answerCount);
      el('#bulkAnswerSheetCandidateWrap').classList.remove('hidden');
      statusEl.textContent = note || `과목/책형이 여러 개로 인식되었습니다. 아래에서 선택해주세요. (${candidates.length}건)`;
    } catch (err) {
      console.error(err);
      statusEl.textContent = '오류: ' + err.message;
    }
  }

  function populateCandidateSelect(rows, answerCount) {
    const sel = el('#bulkAnswerSheetCandidates');
    sel.innerHTML = '';
    rows.forEach((row, i) => {
      const filled = row.answers.filter((a) => a !== undefined && a !== '').length;
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${row.subject || '(과목명 미상)'} · ${row.round || '책형 미상'}책형 (${filled}${answerCount ? '/' + answerCount : ''}문항)`;
      sel.appendChild(opt);
    });
  }

  function fillFromRow(row) {
    const ta = el('#bulkAnswerText');
    if (ta.value.trim() && !confirm('입력되어 있던 정답 목록을 정답표 인식 결과로 덮어쓸까요?')) return;
    ta.value = rowToAnswerText(row);
  }

  function rowToAnswerText(row) {
    const lines = [];
    row.answers.forEach((a, i) => {
      if (a === undefined || a === '') return;
      lines.push(`${i + 1} ${a}`);
    });
    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ *
   * 파일 → 줄(라인) 텍스트 배열
   * ------------------------------------------------------------------ */

  async function analyzeFile(file) {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const lines = isPdf ? await extractPdfLines(file) : await extractImageLines(file);
    let answerCount = detectAnswerCount(lines);
    let rows = parseAnswerTableLines(lines);

    // 폴백: "연번/과목명/책형"이 있는 다과목 표가 아니라, 단일 과목
    // "문제 | 정답 | 문제 | 정답 …" 형태(예: 인사혁신처 "확정답안" 캡처
    // 이미지처럼 문제번호-정답 쌍이 여러 열로 반복되는 표)일 수 있다.
    // 위 상태머신이 한 행도 못 찾았을 때만 시도한다(다과목 표 오인식 방지).
    if (!rows.length) {
      const flat = parseFlatAnswerPairs(lines);
      if (flat) {
        const meta = detectTitleMeta(lines);
        rows = [{ subject: meta.subject, round: meta.round, answers: flat.answers }];
        answerCount = flat.answers.length;
      }
    }

    return { rows, answerCount, isPdf };
  }

  /* ------------------------------------------------------------------ *
   * 단일 과목용 "문제 | 정답" 반복 표 폴백 파서
   * (예: "2007년 7급 공개경쟁채용시험 러시아어(책형:공) 확정답안"처럼
   * 과목명/책형이 표 안이 아니라 제목 줄에 한 번만 나오고, 표 본문은
   * "1 ① 2 ④ 3 ③ 4 ④ 5 ④" 식으로 "문제번호 + 동그라미숫자 정답" 쌍이
   * 한 줄에 여러 개(보통 5쌍) 반복되는 형식. PDF든 이미지(OCR)든 줄
   * 구분이 항상 정확하진 않을 수 있어, 줄 단위가 아니라 전체 텍스트를
   * 이어붙인 뒤 "숫자 + 동그라미숫자" 패턴을 순서대로 훑어서 문제번호별
   * 정답을 채운다(줄바꿈 위치가 틀어져도 쌍 자체는 인접해 있어 안전).
   * ------------------------------------------------------------------ */
  function parseFlatAnswerPairs(lines) {
    const combined = lines.join(' ');
    const re = /(\d{1,3})\s*[.:]?\s*([①②③④⑤⑥⑦⑧⑨])/g;
    const answers = {};
    let maxNum = 0;
    let m;
    while ((m = re.exec(combined))) {
      const num = parseInt(m[1], 10);
      if (num < 1 || num > 300) continue; // 연도/페이지번호 등 오탐 방지용 상한
      if (!(num in answers)) answers[num] = CIRCLED_TO_DIGIT[m[2]] || m[2];
      if (num > maxNum) maxNum = num;
    }
    if (!maxNum) return null;
    const arr = [];
    for (let i = 1; i <= maxNum; i++) arr.push(answers[i] || '');
    // 채워진 칸이 너무 적으면(본문 여기저기 흩어진 숫자를 우연히 엮은
    // 오탐일 가능성) 폴백 자체를 포기한다.
    const filled = arr.filter((a) => a !== '').length;
    if (filled < Math.max(3, maxNum * 0.4)) return null;
    return { answers: arr };
  }

  // 제목 줄에서 과목명/책형 추정: "…채용시험 러시아어(책형:공) 확정답안" 형태.
  // "(책형:X)" 바로 앞의 마지막 한글/영문 단어를 과목명 후보로, 괄호 안
  // 한 글자를 책형으로 본다. 못 찾으면 "책형 X" 단독 표기만이라도 책형을
  // 건지고, 그마저 없으면 둘 다 null(사용자가 후보 목록에서 직접 선택).
  function detectTitleMeta(lines) {
    for (const line of lines) {
      const m = line.match(/([가-힣A-Za-z]+)\s*[(（]\s*책형\s*[:：]?\s*([가-힣A-Za-z0-9])\s*[)）]/);
      if (m) return { subject: m[1], round: m[2] };
    }
    for (const line of lines) {
      const m = line.match(/책형\s*[:：]?\s*([가-힣A-Za-z0-9])(?![가-힣A-Za-z0-9])/);
      if (m) return { subject: null, round: m[1] };
    }
    return { subject: null, round: null };
  }

  function ensurePdfWorker() {
    if (window.pdfjsLib && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
  }

  async function extractPdfLines(file) {
    ensurePdfWorker();
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const scale = 1.5;
    const lineTol = 5; // px, 같은 줄로 볼 y좌표 오차 허용치
    const allLines = [];

    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale });
      const tc = await page.getTextContent();
      const items = tc.items
        .filter((it) => it.str && it.str.trim())
        .map((it) => {
          const [vx, vy] = viewport.convertToViewportPoint(it.transform[4], it.transform[5]);
          return { str: it.str, x: vx, y: vy, w: (it.width || 0) * scale };
        })
        .sort((a, b) => a.y - b.y || a.x - b.x);

      const groups = [];
      let cur = [];
      let curY = null;
      for (const it of items) {
        if (curY === null || Math.abs(it.y - curY) <= lineTol) {
          cur.push(it);
          if (curY === null) curY = it.y;
        } else {
          groups.push(cur);
          cur = [it];
          curY = it.y;
        }
      }
      if (cur.length) groups.push(cur);

      for (const g of groups) {
        g.sort((a, b) => a.x - b.x);
        let text = '';
        let prevEnd = null;
        for (const it of g) {
          if (prevEnd !== null && it.x - prevEnd > 3) text += ' ';
          text += it.str;
          prevEnd = it.x + (it.w || it.str.length * 6);
        }
        allLines.push(text.replace(/\s+/g, ' ').trim());
      }
    }
    return allLines;
  }

  function ensureTesseract() {
    return new Promise((resolve, reject) => {
      if (window.Tesseract) { resolve(); return; }
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.0.4/tesseract.min.js';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('OCR 라이브러리를 불러오지 못했습니다(네트워크 확인 필요). PDF 정답표를 사용해보세요.'));
      document.head.appendChild(s);
    });
  }

  async function extractImageLines(file) {
    el('#bulkAnswerSheetStatus').textContent = '이미지 인식 준비 중… (최초 1회는 다소 오래 걸릴 수 있습니다)';
    await ensureTesseract();
    el('#bulkAnswerSheetStatus').textContent = '이미지에서 문자 인식 중…';
    const { data } = await Tesseract.recognize(file, 'kor+eng');
    return data.text
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }

  /* ------------------------------------------------------------------ *
   * 줄 배열 → 표 구조 파싱
   * ------------------------------------------------------------------ */

  function detectAnswerCount(lines) {
    for (const line of lines) {
      if (line.includes('연번') && line.includes('과목명')) {
        const nums = [...line.matchAll(/(\d{1,2})\s*번/g)].map((m) => parseInt(m[1], 10));
        if (nums.length) return Math.max(...nums);
      }
    }
    return 20; // 못 찾으면 흔한 기본값(4지선다 20문항 기준)으로 폴백
  }

  function isRoundToken(tok) {
    if (ROUND_TOKENS.has(tok)) return true;
    return /^[가-힣A-Za-z]$/.test(tok); // 단일 글자 = 책형일 가능성(과목명은 항상 2글자 이상)
  }

  function isAnswerLikeToken(tok) {
    if (/^\d{1,2}$/.test(tok)) return true;
    if (/^[가-힣]{1,6}$/.test(tok)) return true; // "없음"/"복수정답"/"전항정답" 등 텍스트 정답
    return false;
  }

  // 과목명 토큰 판정: 한글 2글자 이상으로 시작(책형 단일 글자와 구분하기 위함).
  // 중간에 "·"/"/"/"."/"-" 등 구분자나 영문/숫자가 섞인 과목명도 허용.
  function isSubjectNameToken(tok) {
    return /^[가-힣]{2,}[가-힣·/.\-A-Za-z0-9]*$/.test(tok) && !isRoundToken(tok);
  }

  function parseAnswerTableLines(lines) {
    const rows = [];
    // currentSubject: 직전에 확정된 과목명. "이어지는 책형 행"에 재사용됨.
    // pendingRow: 과목명을 아직 모른 채 만들어둔 행(연번+과목명이 별도 줄로
    // 떨어지는 표 형식에서, 그 별도 줄이 뒤에 나오면 여기에 소급 반영됨).
    let currentSubject = null;
    let pendingRow = null;

    for (const raw of lines) {
      const tokens = raw.split(/\s+/).map((t) => t.trim()).filter(Boolean);
      if (!tokens.length) continue;

      // (1) 새 과목 시작 행(한 줄에 다 있는 형식): "연번 과목명 책형 정답들…"
      if (/^\d{1,3}$/.test(tokens[0]) && tokens.length >= 4 && isRoundToken(tokens[2]) &&
          isSubjectNameToken(tokens[1]) && tokens.slice(3).every(isAnswerLikeToken)) {
        const subject = tokens[1];
        const round = tokens[2];
        const answers = tokens.slice(3).map(normalizeAnswerToken);
        currentSubject = subject;
        pendingRow = null;
        rows.push({ subject, round, answers });
        continue;
      }

      // (2) 연번+과목명만 있는 행(책형/정답 없음). 원본 표에서 연번/과목명
      // 셀이 그 과목의 여러 책형 행에 걸쳐 세로로 병합돼 있는 경우, PDF
      // 텍스트 레이어에는 그 병합 셀의 텍스트가 병합 범위의 세로 중앙
      // 높이에 홀로 놓여 별도의 "줄"로 추출된다(2019년 국가공무원 7급
      // 정답표 등에서 확인). 즉 실제 줄 순서는 "가 책형 행" → "연번+과목명
      // 행" → "다 책형 행" 처럼 과목명 행이 책형 행들 사이에 끼어 나온다.
      if (/^\d{1,3}$/.test(tokens[0]) && tokens.length === 2 && isSubjectNameToken(tokens[1])) {
        const subject = tokens[1];
        currentSubject = subject;
        // 바로 앞서 과목명을 몰라 만들어둔 행(그 과목의 첫 책형 행)이 있으면
        // 지금 확정된 과목명을 소급 반영한다.
        if (pendingRow && pendingRow.subject === null) pendingRow.subject = subject;
        pendingRow = null;
        continue;
      }

      // (3) 책형+정답만 있는 행(과목명/연번 생략)
      if (isRoundToken(tokens[0]) && tokens.length >= 2 && tokens.slice(1).every(isAnswerLikeToken)) {
        const round = tokens[0];
        const answers = tokens.slice(1).map(normalizeAnswerToken);
        // 그 표에서 항상 맨 처음 등장하는 책형('가'/'A')이면, 아직 과목명을
        // 모르는 새 과목 블록의 시작으로 간주한다(연번+과목명이 뒤이어 오는
        // 별도 줄로 나올 것으로 기대). currentSubject가 아직 없을 때도
        // (문서 맨 앞부분 등) 마찬가지로 과목명 미상 상태로 만들어둔다.
        // 그 외(나/다/라/마 등, currentSubject 존재)는 직전 과목의 이어지는
        // 책형 행으로 보고 그대로 재사용한다.
        if (FIRST_ROUND_TOKENS.has(round) || !currentSubject) {
          const row = { subject: null, round, answers };
          rows.push(row);
          pendingRow = row;
          currentSubject = null; // 과목명이 다시 확정되기 전까지 재사용 금지
        } else {
          rows.push({ subject: currentSubject, round, answers });
        }
        continue;
      }

      // 그 외(제목/머리말/페이지번호 등)는 무시
    }

    // 끝까지 과목명을 못 채운 행(표 형식이 예상과 달라 소급 반영이 안 된
    // 경우)은 매칭 대상에서 제외한다.
    return rows.filter((r) => r.subject);
  }

  function normalizeAnswerToken(tok) {
    return CIRCLED_TO_DIGIT[tok] || tok;
  }

  /* ------------------------------------------------------------------ *
   * 매칭
   * ------------------------------------------------------------------ */

  function normalizeSubject(s) {
    return String(s || '').replace(/\s+/g, '').replace(/[()（）]/g, '');
  }

  function normalizeRound(s) {
    return String(s || '').replace(/\s+/g, '').replace(/책형$/, '');
  }

  function roundsMatch(a, b) {
    const na = normalizeRound(a), nb = normalizeRound(b);
    if (!na || !nb) return false;
    return na === nb;
  }

  function findSubjectCandidates(rows, subjectQuery) {
    const nq = normalizeSubject(subjectQuery);
    if (!nq) return [];
    let exact = rows.filter((r) => normalizeSubject(r.subject) === nq);
    if (exact.length) return exact;
    return rows.filter((r) => {
      const ns = normalizeSubject(r.subject);
      return ns.includes(nq) || nq.includes(ns);
    });
  }

  return {
    init,
    resetUI,
    // 아래는 "시험/연도별 일괄 적용" 기능(library.js)에서 재사용하기 위해
    // 공개하는 저수준 유틸리티. 단일 문제지용 UI(이 모듈 자체)와 동일한
    // 파싱/매칭 로직을 그대로 공유해서 두 기능의 인식 결과가 어긋나지
    // 않도록 한다.
    analyzeFile,
    findSubjectCandidates,
    roundsMatch,
    normalizeSubject,
    normalizeRound,
  };
})();

window.AnswerSheetImport = AnswerSheetImport;
