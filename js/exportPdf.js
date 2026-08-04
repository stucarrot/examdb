/* exportPdf.js — 선택한 문제들을 하나의 PDF로 재조립해서 다운로드 */

const ExportPDF = (() => {
  let pendingQuestions = [];

  function el(sel, root = document) { return root.querySelector(sel); }

  function init() {
    el('#exportCancel').addEventListener('click', () => el('#exportModal').classList.add('hidden'));
    el('#exportRun').addEventListener('click', runExport);
  }

  function openExportDialog(questions) {
    pendingQuestions = questions;
    el('#exportCount').textContent = `${questions.length}개 문제 선택됨`;
    el('#exportModal').classList.remove('hidden');
  }

  async function runExport() {
    const title = el('#exportTitle').value.trim() || '문제 모음';
    const orderBy = el('#exportOrder').value; // 'selection' | 'qnum' | 'exam-qnum'
    const includeAnswerSheet = el('#exportAnswerChk').checked;
    const includeInlineAnswer = el('#exportInlineAnswerChk').checked;
    const includeInlineId = el('#exportInlineIdChk').checked;
    const runBtn = el('#exportRun');
    runBtn.disabled = true;
    el('#exportStatus').textContent = '생성 중…';

    try {
      let list = pendingQuestions.slice();
      if (orderBy === 'qnum') list.sort((a, b) => a.qnum - b.qnum);
      if (orderBy === 'exam-qnum') list.sort((a, b) => (a.code || '').localeCompare(b.code || ''));

      const { PDFDocument } = PDFLib;
      const pdfDoc = await PDFDocument.create();
      const pageWidth = 595.28, pageHeight = 841.89; // A4
      const margin = 36;
      let page = pdfDoc.addPage([pageWidth, pageHeight]);
      let cursorY = pageHeight - margin;

      let done = 0;
      for (const q of list) {
        const blobs = await DB.getImageBlobs(q);
        const maxW = pageWidth - margin * 2;
        let lastDrawW = maxW; // 라벨 글자 크기를 이 문제 이미지 폭에 비례시키기 위해 기억해둠
        for (const blob of blobs) {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let img;
          try { img = await pdfDoc.embedJpg(bytes); } catch (e) { img = await pdfDoc.embedPng(bytes); }
          const natural = img.scale(1);
          let drawW = maxW;
          let drawH = natural.height * (drawW / natural.width);
          if (drawH > pageHeight - margin * 2) {
            drawH = pageHeight - margin * 2;
            drawW = natural.width * (drawH / natural.height);
          }
          if (cursorY - drawH < margin) {
            page = pdfDoc.addPage([pageWidth, pageHeight]);
            cursorY = pageHeight - margin;
          }
          page.drawImage(img, { x: margin, y: cursorY - drawH, width: drawW, height: drawH });
          cursorY -= drawH + 16;
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
          const lw = label.width, lh = label.height;
          if (cursorY - lh < margin) {
            page = pdfDoc.addPage([pageWidth, pageHeight]);
            cursorY = pageHeight - margin;
          }
          page.drawImage(labelImg, { x: pageWidth - margin - lw, y: cursorY - lh, width: lw, height: lh });
          cursorY -= lh + 6;
        }

        done++;
        el('#exportStatus').textContent = `이미지 삽입 중… (${done}/${list.length})`;
      }

      if (includeAnswerSheet) {
        const canvas = buildAnswerSheetCanvas(list, title);
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

      el('#exportStatus').textContent = 'PDF 파일 저장 중…';
      const pdfBytes = await pdfDoc.save();
      downloadBlob(new Blob([pdfBytes], { type: 'application/pdf' }), sanitizeFilename(title) + '.pdf');
      el('#exportStatus').textContent = '완료되었습니다.';
      setTimeout(() => el('#exportModal').classList.add('hidden'), 800);
    } catch (err) {
      console.error(err);
      el('#exportStatus').textContent = '오류: ' + err.message;
    } finally {
      runBtn.disabled = false;
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
