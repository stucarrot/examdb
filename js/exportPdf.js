/* exportPdf.js — 선택한 문제들을 하나(또는 무작위 분할 시 여러 개)의 PDF로 재조립해서 다운로드.
 *
 * 지원 기능:
 *  1. 기본: pendingQuestions(필터/선택된 범위) 전체를 정렬 방식대로 이어붙여 PDF 1개.
 *  2. 무작위 분할: pendingQuestions 중 N개를 무작위로 뽑아, 그걸 다시 K개 시험지로 고르게
 *     나눠서(각 N/K문항) PDF를 K개 만든다 — K==1이면 PDF 1개 그대로 다운로드, K>=2면
 *     JSZip으로 묶어서 zip 1개로 다운로드(브라우저가 여러 개 다운로드를 한꺼번에 막는 걸 피함).
 *  3. 레이아웃: '기존 방식'(single, 예전 그대로 1단)과 '2단 편집'(twocol, 실제 시험지처럼
 *     상단 제목/컬럼 구분선/하단 쪽번호를 추가) 중 선택. single은 기존 코드 경로와 완전히
 *     동일한 출력을 내도록 신경 써서 만들었다(회귀 없음).
 */

const ExportPDF = (() => {
  let pendingQuestions = [];

  function el(sel, root = document) { return root.querySelector(sel); }

  function init() {
    el('#exportCancel').addEventListener('click', () => el('#exportModal').classList.add('hidden'));
    el('#exportRun').addEventListener('click', runExport);
    el('#exportRandomSplitChk').addEventListener('change', (e) => {
      el('#exportSplitFields').classList.toggle('hidden', !e.target.checked);
      updateSplitHint();
    });
    el('#exportRandomN').addEventListener('input', updateSplitHint);
    el('#exportRandomK').addEventListener('input', updateSplitHint);
  }

  function openExportDialog(questions) {
    pendingQuestions = questions;
    el('#exportCount').textContent = `${questions.length}개 문제 선택됨`;
    el('#exportStatus').textContent = '';
    // 모달을 새로 열 때마다 무작위 분할 옵션은 꺼진 상태로 시작하고(매번 켜져 있으면 실수로
    // 무작위 분할이 되는 사고를 방지), N은 이번 범위 전체 개수로 기본값을 채워둔다.
    el('#exportRandomSplitChk').checked = false;
    el('#exportSplitFields').classList.add('hidden');
    el('#exportRandomN').value = questions.length;
    el('#exportRandomK').value = 1;
    updateSplitHint();
    el('#exportModal').classList.remove('hidden');
  }

  /** N/K 입력값이 바뀔 때마다 "시험지 3개, 각 10문제씩" 같은 미리보기 문구를 갱신 */
  function updateSplitHint() {
    const hintEl = el('#exportSplitHint');
    if (!el('#exportRandomSplitChk').checked) { hintEl.textContent = ''; return; }
    const n = parseInt(el('#exportRandomN').value, 10);
    const k = parseInt(el('#exportRandomK').value, 10);
    if (!n || n < 1 || !k || k < 1) { hintEl.textContent = '총 문제 수와 시험지 개수를 입력하세요.'; return; }
    if (n > pendingQuestions.length) {
      hintEl.textContent = `⚠ 이 범위에는 ${pendingQuestions.length}문제만 있습니다 (N을 그 이하로 입력).`;
      return;
    }
    if (k > n) { hintEl.textContent = '⚠ 시험지 개수(K)는 총 문제 수(N)보다 많을 수 없습니다.'; return; }
    const base = Math.floor(n / k);
    const remainder = n % k;
    hintEl.textContent = remainder === 0
      ? `→ 시험지 ${k}개, 각 ${base}문제씩 (총 ${n}문제 사용, 파일 ${k}개${k > 1 ? '를 zip으로 묶어' : ''} 다운로드)`
      : `→ 시험지 ${k}개 중 ${remainder}개는 ${base + 1}문제, 나머지 ${k - remainder}개는 ${base}문제 (총 ${n}문제 사용)`;
  }

  async function runExport() {
    const title = el('#exportTitle').value.trim() || '문제 모음';
    const orderBy = el('#exportOrder').value; // 'selection' | 'qnum' | 'exam-qnum'
    const layout = el('#exportLayout').value; // 'single'(기존 방식) | 'twocol'(2단 편집)
    const includeAnswerSheet = el('#exportAnswerChk').checked;
    const includeInlineAnswer = el('#exportInlineAnswerChk').checked;
    const includeInlineId = el('#exportInlineIdChk').checked;
    const randomSplit = el('#exportRandomSplitChk').checked;
    const runBtn = el('#exportRun');
    runBtn.disabled = true;
    el('#exportStatus').textContent = '생성 중…';

    const commonOpts = { title, orderBy, includeAnswerSheet, includeInlineAnswer, includeInlineId, layout };

    try {
      if (!randomSplit) {
        // ---- 기본: 이 범위(pendingQuestions) 전체를 그대로 PDF 1개로 ----
        const bytes = await buildExamPdfBytes(pendingQuestions, {
          ...commonOpts,
          onProgress: (done, total) => { el('#exportStatus').textContent = `이미지 삽입 중… (${done}/${total})`; },
        });
        el('#exportStatus').textContent = 'PDF 파일 저장 중…';
        downloadBlob(new Blob([bytes], { type: 'application/pdf' }), sanitizeFilename(title) + '.pdf');
        el('#exportStatus').textContent = '완료되었습니다.';
        setTimeout(() => el('#exportModal').classList.add('hidden'), 800);
        return;
      }

      // ---- 무작위 분할: N개를 무작위로 뽑아 K개 시험지로 고르게 나눈다 ----
      const n = parseInt(el('#exportRandomN').value, 10);
      const k = parseInt(el('#exportRandomK').value, 10);
      if (!n || n < 1 || n > pendingQuestions.length) {
        el('#exportStatus').textContent = `총 문제 수(N)는 1~${pendingQuestions.length} 사이로 입력하세요.`;
        return;
      }
      if (!k || k < 1 || k > n) {
        el('#exportStatus').textContent = '시험지 개수(K)는 1 이상, 총 문제 수(N) 이하로 입력하세요.';
        return;
      }

      const picked = pickRandomSubset(pendingQuestions, n);
      const chunks = splitEvenly(picked, k);
      const files = [];
      for (let i = 0; i < chunks.length; i++) {
        const paperTitle = k === 1 ? title : `${title} - ${i + 1}회`;
        const bytes = await buildExamPdfBytes(chunks[i], {
          ...commonOpts,
          title: paperTitle,
          onProgress: (done, total) => {
            el('#exportStatus').textContent = `${i + 1}/${chunks.length}번째 시험지 · 이미지 삽입 중… (${done}/${total})`;
          },
        });
        files.push({ name: sanitizeFilename(paperTitle) + '.pdf', bytes });
      }

      if (files.length === 1) {
        downloadBlob(new Blob([files[0].bytes], { type: 'application/pdf' }), files[0].name);
      } else {
        el('#exportStatus').textContent = 'zip 파일로 묶는 중…';
        const zip = new JSZip();
        files.forEach((f) => zip.file(f.name, f.bytes));
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        downloadBlob(zipBlob, sanitizeFilename(title) + `_시험지${files.length}종.zip`);
      }
      el('#exportStatus').textContent = '완료되었습니다.';
      setTimeout(() => el('#exportModal').classList.add('hidden'), 800);
    } catch (err) {
      console.error(err);
      el('#exportStatus').textContent = '오류: ' + err.message;
    } finally {
      runBtn.disabled = false;
    }
  }

  /** list에서 n개를 무작위로 뽑는다(Fisher–Yates). 원본 배열은 건드리지 않음. */
  function pickRandomSubset(list, n) {
    const arr = list.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, n);
  }

  /** list를 k개 묶음으로 최대한 고르게 나눈다(나머지는 앞쪽 묶음부터 하나씩 더 받음).
   * 예: 10개를 3묶음 → [4, 3, 3]. */
  function splitEvenly(list, k) {
    const base = Math.floor(list.length / k);
    const remainder = list.length % k;
    const chunks = [];
    let idx = 0;
    for (let i = 0; i < k; i++) {
      const size = base + (i < remainder ? 1 : 0);
      chunks.push(list.slice(idx, idx + size));
      idx += size;
    }
    return chunks;
  }

  /**
   * 문제 목록 하나를 PDF 바이트로 조립한다. layout에 따라 1단(기존 방식)/2단(실제 시험지처럼)
   * 중 하나로 그려진다 — 'single'일 때는 예전 exportPdf.js와 동일한 출력이 나오도록
   * 맞췄다(정렬/줄바꿈 조건이 원래 코드와 한 줄 한 줄 대응됨. 회귀 없음).
   */
  async function buildExamPdfBytes(list, opts) {
    const { title, orderBy, includeAnswerSheet, includeInlineAnswer, includeInlineId, layout, onProgress } = opts;
    let ordered = list.slice();
    if (orderBy === 'qnum') ordered.sort((a, b) => a.qnum - b.qnum);
    if (orderBy === 'exam-qnum') ordered.sort((a, b) => (a.code || '').localeCompare(b.code || ''));

    const { PDFDocument, rgb } = PDFLib;
    const pdfDoc = await PDFDocument.create();
    const pageWidth = 595.28, pageHeight = 841.89; // A4
    const margin = 36;
    const columns = layout === 'twocol' ? 2 : 1;

    // 2단 편집일 때만: 상단에 실제 시험지 느낌의 제목 헤더를 준비해서, 첫 페이지 시작 커서를
    // 그만큼 아래로 미리 밀어둔다(ColumnLayout 생성 전에 높이를 알아야 함).
    let headerImg = null, headerHeight = 0;
    if (columns === 2) {
      const header = buildHeaderCanvas(title, ordered.length, pageWidth - margin * 2);
      const headerBytes = dataURLToUint8Array(header.canvas.toDataURL('image/png'));
      headerImg = await pdfDoc.embedPng(headerBytes);
      headerHeight = header.height + 14; // 헤더 아래 여백 14pt
    }

    const lay = new ColumnLayout(pdfDoc, pageWidth, pageHeight, margin, columns, columns === 2 ? rgb : null, headerHeight);
    if (headerImg) {
      const header = { width: pageWidth - margin * 2, height: headerHeight - 14 };
      lay.page.drawImage(headerImg, { x: margin, y: pageHeight - margin - header.height, width: header.width, height: header.height });
    }

    let done = 0;
    for (const q of ordered) {
      const blobs = await DB.getImageBlobs(q);
      let lastDrawW = lay.colWidth; // 라벨 글자 크기를 이 문제 이미지 폭에 비례시키기 위해 기억해둠
      for (const blob of blobs) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let img;
        try { img = await pdfDoc.embedJpg(bytes); } catch (e) { img = await pdfDoc.embedPng(bytes); }
        const natural = img.scale(1);
        let drawW = lay.colWidth;
        let drawH = natural.height * (drawW / natural.width);
        const maxH = pageHeight - margin * 2;
        if (drawH > maxH) {
          drawH = maxH;
          drawW = natural.width * (drawH / natural.height);
        }
        lay.drawImage(img, drawW, drawH);
        lay.addGap(16);
        lastDrawW = drawW;
      }

      const inlineLabelParts = [];
      if (includeInlineAnswer && q.answer) inlineLabelParts.push(`정답: ${formatAnswerLabel(q.answer)}`);
      if (includeInlineId) inlineLabelParts.push(q.code || q.id);
      if (inlineLabelParts.length) {
        const label = buildInlineLabelCanvas(inlineLabelParts, lastDrawW);
        const labelBytes = dataURLToUint8Array(label.canvas.toDataURL('image/png'));
        const labelImg = await pdfDoc.embedPng(labelBytes);
        // label.width/height는 캔버스 논리 크기(=PDF에 그릴 실제 포인트 크기).
        // labelImg.width/height는 레티나 선명도용으로 2배 키운 실제 픽셀 수라서
        // 그대로 쓰면 글자가 의도보다 2배 크게 찍힌다 — 반드시 논리 크기를 써야 함.
        lay.drawLabelImage(labelImg, label.width, label.height);
      }

      done++;
      if (onProgress) onProgress(done, ordered.length);
    }

    if (columns === 2) {
      // 실제 시험지처럼 하단 중앙에 쪽번호 — 총 페이지 수를 알아야 하므로 다 그린 뒤 한 번에 찍는다.
      const pages = pdfDoc.getPages();
      for (let i = 0; i < pages.length; i++) {
        const footer = buildFooterCanvas(`- ${i + 1} / ${pages.length} -`, pageWidth);
        const footerBytes = dataURLToUint8Array(footer.canvas.toDataURL('image/png'));
        const footerImg = await pdfDoc.embedPng(footerBytes);
        pages[i].drawImage(footerImg, { x: 0, y: margin - footer.height - 4, width: footer.width, height: footer.height });
      }
    }

    if (includeAnswerSheet) {
      const canvas = buildAnswerSheetCanvas(ordered, title);
      const dataUrl = canvas.toDataURL('image/png');
      const bytes = dataURLToUint8Array(dataUrl);
      const img = await pdfDoc.embedPng(bytes);
      const p2 = pdfDoc.addPage([pageWidth, pageHeight]);
      const scale = Math.min((pageWidth - margin * 2) / img.width, (pageHeight - margin * 2) / img.height, 1);
      p2.drawImage(img, {
        x: margin,
        y: pageHeight - margin - img.height * scale,
        width: img.width * scale,
        height: img.height * scale,
      });
    }

    return pdfDoc.save();
  }

  /**
   * 페이지 안에서 커서 위치(cursorY)와 1단/2단 컬럼 전환, 새 페이지 추가를 관리한다.
   * columns===1일 때는(기존 방식) colX/colWidth가 항상 페이지 전체 폭 한 칸이라 예전
   * exportPdf.js의 단순 페이지-넘김 로직과 동작이 완전히 동일하다.
   * columns===2일 때만 컬럼 사이 구분선을 매 페이지 자동으로 그려서 실제 시험지 느낌을 낸다.
   */
  class ColumnLayout {
    constructor(pdfDoc, pageWidth, pageHeight, margin, columns, rgbFn, headerReserve) {
      this.pdfDoc = pdfDoc;
      this.pageWidth = pageWidth;
      this.pageHeight = pageHeight;
      this.margin = margin;
      this.columns = columns;
      this.rgbFn = rgbFn;
      this.headerReserve = headerReserve || 0; // 문서의 첫 페이지에서만 이만큼 위에서부터 비워둠
      this.gutter = columns === 2 ? 22 : 0;
      this.colWidth = columns === 2
        ? (pageWidth - margin * 2 - this.gutter) / 2
        : (pageWidth - margin * 2);
      this.page = null;
      this.colIndex = 0;
      this.cursorY = 0;
      this.pageCount = 0;
      this._newPage();
    }
    _drawDivider() {
      if (this.columns !== 2 || !this.rgbFn) return;
      const midX = this.margin + this.colWidth + this.gutter / 2;
      this.page.drawLine({
        start: { x: midX, y: this.margin },
        end: { x: midX, y: this.pageHeight - this.margin },
        thickness: 0.6,
        color: this.rgbFn(0.75, 0.75, 0.75),
      });
    }
    _topCursorY() {
      // 첫 페이지(문서 전체에서 한 번)에만 헤더만큼 아래에서 시작 — 2쪽부터는 꽉 채워 씀
      return this.pageHeight - this.margin - (this.pageCount === 1 ? this.headerReserve : 0);
    }
    _newPage() {
      this.page = this.pdfDoc.addPage([this.pageWidth, this.pageHeight]);
      this.pageCount++;
      this.colIndex = 0;
      this.cursorY = this._topCursorY();
      this._drawDivider();
    }
    _nextSlot() {
      if (this.columns === 2 && this.colIndex === 0) {
        this.colIndex = 1;
        this.cursorY = this._topCursorY();
      } else {
        this._newPage();
      }
    }
    get colX() { return this.margin + this.colIndex * (this.colWidth + this.gutter); }
    ensureSpace(h) {
      if (this.cursorY - h < this.margin) this._nextSlot();
    }
    drawImage(img, w, h) {
      this.ensureSpace(h);
      this.page.drawImage(img, { x: this.colX, y: this.cursorY - h, width: w, height: h });
      this.cursorY -= h;
    }
    addGap(g) { this.cursorY -= g; }
    drawLabelImage(img, w, h) {
      this.ensureSpace(h);
      this.page.drawImage(img, { x: this.colX + this.colWidth - w, y: this.cursorY - h, width: w, height: h });
      this.cursorY -= h + 6;
    }
  }

  function buildAnswerSheetCanvas(questions, title) {
    const cols = 5;
    const rowH = 26;
    const colW = 150;
    const rows = Math.ceil(questions.length / cols);
    const width = 60 + cols * colW;
    const height = 90 + rows * rowH;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#111827';
    ctx.font = 'bold 22px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
    ctx.fillText(title + ' - 정답', 30, 40);
    ctx.font = '14px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
    ctx.fillText(`생성일: ${new Date().toLocaleString()}`, 30, 62);

    ctx.font = '15px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
    questions.forEach((q, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = 30 + col * colW;
      const y = 90 + row * rowH;
      const text = `${i + 1}. (${q.code || q.examTitle}) → ${q.answer || '미입력'}`;
      ctx.fillText(text.length > 24 ? text.slice(0, 24) + '…' : text, x, y);
    });
    return canvas;
  }

  /** 2단 편집(twocol) 레이아웃 전용: 문서 첫 페이지 맨 위에 올라가는 "실제 시험지처럼" 보이는
   * 제목 헤더를 캔버스(→PNG)로 만든다. 제목 + "총 N문항 · 생성일" + 밑줄 한 줄. */
  function buildHeaderCanvas(title, count, widthPt) {
    const scale = 2;
    const width = widthPt;
    const height = 54;
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#111827';
    ctx.textBaseline = 'alphabetic';
    ctx.font = 'bold 20px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
    const displayTitle = title.length > 40 ? title.slice(0, 40) + '…' : title;
    ctx.fillText(displayTitle, 0, 24);
    ctx.font = '11px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
    ctx.fillStyle = '#6b7280';
    ctx.fillText(`총 ${count}문항 · 생성일: ${new Date().toLocaleDateString()}`, 0, 42);
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0, 50);
    ctx.lineTo(width, 50);
    ctx.stroke();
    return { canvas, width, height };
  }

  /** 2단 편집(twocol) 레이아웃 전용: 페이지 하단 중앙에 찍는 작은 쪽번호. */
  function buildFooterCanvas(text, widthPt) {
    const scale = 2;
    const width = widthPt;
    const height = 16;
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.font = '9px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
    ctx.fillStyle = '#9ca3af';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, width / 2, height / 2);
    return { canvas, width, height };
  }

  const CIRCLED_DIGITS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];

  /** 정답 문자열을 사람이 읽기 좋은 표시로 변환. 1~9 숫자면 동그라미 숫자로,
   * 그 외(복수정답/전항정답 등 텍스트)는 원문 그대로 보여준다. */
  function formatAnswerLabel(answer) {
    const trimmed = String(answer).trim();
    if (/^[1-9]$/.test(trimmed)) return CIRCLED_DIGITS[parseInt(trimmed, 10) - 1];
    return trimmed;
  }

  /** 문제 이미지 뒤에 붙일 "정답: ③" / 문제ID 라벨을 캔버스(→PNG)로 만든다.
   * pdf-lib 표준폰트는 한글 글리프가 없어 텍스트를 직접 그릴 수 없으므로,
   * 기존 정답요약 페이지(buildAnswerSheetCanvas)와 같은 방식으로 캔버스에
   * 그려 이미지로 삽입한다.
   * 정답 표시와 문제ID 표시를 각각 별도 옵션으로 켤 수 있지만, 둘 다 켜져
   * 있으면 문제 아래 공간을 이중으로 차지하지 않도록 한 줄에 이어붙여
   * 하나의 라벨로 그린다(예: "정답: ③   5급공채_2026_자료해석_나책형_01").
   *
   * refWidth: 이 문제 이미지가 PDF 페이지에 실제로 그려지는 폭(pt). 문제
   * 이미지는 원본 지면의 한 컬럼(문제 본문 폭)을 페이지 폭에 맞춰 확대해서
   * 그리므로, 그 폭에 비례해서 라벨 글자 크기를 정해야 "본문 글자의 대략
   * 절반 정도" 크기로 자연스럽게 맞는다(고정 크기로 두면 이미지가 작게
   * 찍히는 문제에서는 라벨이 상대적으로 너무 커 보인다). */
  function buildInlineLabelCanvas(parts, refWidth) {
    const text = parts.join('   ');
    const scale = 2; // 해상도 보정(레티나 대비 선명하게) — PDF에는 아래 논리 크기로 그려짐
    const fontSize = Math.max(6, Math.min(10, Math.round((refWidth || 480) * 0.017)));
    const measureCanvas = document.createElement('canvas');
    const mctx = measureCanvas.getContext('2d');
    mctx.font = `italic ${fontSize}px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`;
    const textWidth = mctx.measureText(text).width;

    const padX = 4, padY = 2;
    const width = Math.ceil(textWidth) + padX * 2;
    const height = fontSize + padY * 2;
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.textBaseline = 'middle';
    ctx.font = `italic ${fontSize}px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`;
    ctx.fillStyle = '#8a8a8a';
    ctx.fillText(text, padX, height / 2);
    // width/height는 스케일 적용 전 논리 크기 — PDF drawImage에는 이 값을
    // 써야 캔버스 실제 픽셀 수(scale배 큰 값)로 인해 2배 크게 찍히지 않는다.
    return { canvas, width, height };
  }

  function dataURLToUint8Array(dataUrl) {
    const base64 = dataUrl.split(',')[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function sanitizeFilename(s) {
    return s.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'export';
  }

  return { init, openExportDialog };
})();

window.ExportPDF = ExportPDF;
