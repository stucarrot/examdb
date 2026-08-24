/* exportChoices.js — 필터링한 선지(choices) 목록을 PDF 한 장(또는 여러 장)으로 내보낸다.
 *
 * pdf-lib 표준폰트는 한글 글리프가 없어 텍스트를 직접 그릴 수 없으므로,
 * exportPdf.js의 buildAnswerSheetCanvas/buildInlineLabelCanvas와 같은 방식으로
 * 브라우저 canvas에 한글 텍스트를 그려 PNG로 만든 뒤 PDF 페이지에 이미지로
 * 삽입한다(이 프로젝트 전체에서 한글 텍스트를 PDF에 넣을 때 쓰는 유일한 방법).
 *
 * 페이지 단위 캔버스를 하나씩 만들어 내용을 그려나가다가, 남은 세로 공간이
 * 부족해지면 그 캔버스를 PDF 페이지로 확정(embedPng)하고 새 캔버스를 이어서
 * 쓰는 식으로 페이지 수 제한 없이 임의 개수의 선지를 처리한다.
 *
 * 줄바꿈은 단어 단위가 아니라 "글자 단위"로 한다 — 한국어는 띄어쓰기 없이
 * 길게 이어지는 구간이 흔해서(특히 선지 텍스트) 단어 단위 wrap은 한 단어가
 * 폭을 넘는 경우를 계속 예외 처리해야 해서 오히려 더 복잡하고 버그가 나기
 * 쉽다. 글자 단위로 자르는 건 한국어 조판에서도 흔히 쓰이는 방식이라
 * 가독성 문제도 크지 않다.
 */

const ExportChoices = (() => {
  // A4 비율에 맞춘 캔버스 픽셀 크기(약 150dpi) — exportPdf.js의 A4 pt 크기(595.28×841.89)와
  // 별개로, 여기서는 캔버스를 페이지 전체 이미지로 그대로 삽입하므로 비율만 맞으면 된다.
  const CANVAS_W = 1240;
  const CANVAS_H = 1754;
  const MARGIN = 64;
  const PAGE_W_PT = 595.28;
  const PAGE_H_PT = 841.89;

  const FONT_STACK = '"Malgun Gothic","Apple SD Gothic Neo",sans-serif';
  const BODY_SIZE = 20;
  const SMALL_SIZE = 14;
  const BODY_LINE_H = 30;
  const SMALL_LINE_H = 21;
  const ITEM_GAP = 16;

  /** 글자 단위로 maxWidth를 넘지 않게 줄바꿈. ctx.font가 미리 설정되어 있어야 한다. */
  function wrapByChar(ctx, text, maxWidth) {
    const lines = [];
    let cur = '';
    for (const ch of text) {
      const test = cur + ch;
      if (cur.length && ctx.measureText(test).width > maxWidth) {
        lines.push(cur);
        cur = ch;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  function dataURLToUint8Array(dataUrl) {
    const base64 = dataUrl.split(',')[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /**
   * @param {Array} list 선지 레코드 배열(db.js choices 스토어 형태): { code, marker, text, ox, memo, ... }
   * @param {Object} opts { title, includeOx, includeMemo }
   * @returns {Promise<Blob>} application/pdf
   */
  async function buildPdf(list, opts = {}) {
    const title = opts.title || '선지 모음';
    const includeOx = !!opts.includeOx;
    const includeMemo = !!opts.includeMemo;

    const { PDFDocument } = PDFLib;
    const pdfDoc = await PDFDocument.create();

    let canvas, ctx, cursorY;

    function newPage() {
      canvas = document.createElement('canvas');
      canvas.width = CANVAS_W;
      canvas.height = CANVAS_H;
      ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      cursorY = MARGIN;
    }

    async function flushPage() {
      const dataUrl = canvas.toDataURL('image/png');
      const bytes = dataURLToUint8Array(dataUrl);
      const img = await pdfDoc.embedPng(bytes);
      const page = pdfDoc.addPage([PAGE_W_PT, PAGE_H_PT]);
      page.drawImage(img, { x: 0, y: 0, width: PAGE_W_PT, height: PAGE_H_PT });
    }

    /** 다음 요소를 그리기 전, 이 높이(px)만큼 공간이 남아있는지 확인하고
     * 부족하면 지금까지의 캔버스를 페이지로 확정한 뒤 새 캔버스를 시작한다. */
    async function ensureSpace(neededH) {
      if (cursorY + neededH > CANVAS_H - MARGIN) {
        await flushPage();
        newPage();
      }
    }

    newPage();
    const contentW = CANVAS_W - MARGIN * 2;

    // ---- 제목/부제 ----
    ctx.fillStyle = '#111827';
    ctx.font = `bold 32px ${FONT_STACK}`;
    ctx.fillText(title, MARGIN, cursorY + 32);
    cursorY += 54;
    ctx.font = `16px ${FONT_STACK}`;
    ctx.fillStyle = '#6b7280';
    ctx.fillText(`생성일: ${new Date().toLocaleString()}  ·  총 ${list.length}개 선지`, MARGIN, cursorY);
    cursorY += 40;

    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const label = `${i + 1}. `;
      const codePart = c.questionCode || c.code || '';
      const marker = c.marker ? c.marker + ' ' : '';
      const mainText = `${label}[${codePart}] ${marker}${c.text || ''}`;

      await ensureSpace(BODY_LINE_H * 2); // 최소 두 줄은 들어갈 공간 확보 후 시작(첫 줄이 페이지 경계에서 잘리지 않도록)
      ctx.font = `${BODY_SIZE}px ${FONT_STACK}`;
      ctx.fillStyle = '#111827';
      const lines = wrapByChar(ctx, mainText, contentW);

      let lastLineWidth = 0;
      for (let li = 0; li < lines.length; li++) {
        await ensureSpace(BODY_LINE_H);
        ctx.font = `${BODY_SIZE}px ${FONT_STACK}`;
        ctx.fillStyle = '#111827';
        ctx.fillText(lines[li], MARGIN, cursorY + BODY_SIZE * 0.8);
        lastLineWidth = ctx.measureText(lines[li]).width;
        cursorY += BODY_LINE_H;
      }

      // ---- 선지 끝에 작은 회색 글씨로 OX 정답 ----
      if (includeOx && c.ox) {
        const oxText = `  (정답: ${c.ox})`;
        ctx.font = `italic ${SMALL_SIZE}px ${FONT_STACK}`;
        const oxW = ctx.measureText(oxText).width;
        if (lastLineWidth + oxW <= contentW) {
          // 방금 그린 마지막 줄 바로 뒤에 이어 붙인다(같은 줄, 커서는 이미 다음 줄로 넘어간 상태이므로 되돌려서 그림)
          ctx.fillStyle = '#9ca3af';
          ctx.fillText(oxText, MARGIN + lastLineWidth, cursorY - BODY_LINE_H + BODY_SIZE * 0.8);
        } else {
          await ensureSpace(SMALL_LINE_H);
          ctx.font = `italic ${SMALL_SIZE}px ${FONT_STACK}`;
          ctx.fillStyle = '#9ca3af';
          ctx.fillText(oxText.trim(), MARGIN + 16, cursorY + SMALL_SIZE * 0.8);
          cursorY += SMALL_LINE_H;
        }
      }

      // ---- 아랫줄에 메모 ----
      if (includeMemo && c.memo) {
        const memoLines = wrapByChar(ctx, `메모: ${c.memo}`, contentW - 16);
        for (const ml of memoLines) {
          await ensureSpace(SMALL_LINE_H);
          ctx.font = `${SMALL_SIZE}px ${FONT_STACK}`;
          ctx.fillStyle = '#6b7280';
          ctx.fillText(ml, MARGIN + 16, cursorY + SMALL_SIZE * 0.8);
          cursorY += SMALL_LINE_H;
        }
      }

      cursorY += ITEM_GAP;
      // 항목 사이 옅은 구분선(가독성)
      if (cursorY < CANVAS_H - MARGIN) {
        ctx.strokeStyle = '#e5e7eb';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(MARGIN, cursorY - ITEM_GAP / 2);
        ctx.lineTo(CANVAS_W - MARGIN, cursorY - ITEM_GAP / 2);
        ctx.stroke();
      }
    }

    await flushPage();
    const pdfBytes = await pdfDoc.save();
    return new Blob([pdfBytes], { type: 'application/pdf' });
  }

  return { buildPdf };
})();

window.ExportChoices = ExportChoices;
