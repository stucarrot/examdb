/* structure.js — 문제 하나를 "구성요소"로 나눠 인식한다 (언어논리/자료해석/상황판단 대상).
 *
 * 구성요소 분류(요청 사양):
 *   설문부(group:'stem')    : setStem(세트 공통지문의 시작설문), stem(일반 문제의 설문)
 *   자료부(group:'data')    : text(문단 단위 텍스트), box_titled/box_plain(테두리 박스, 제목 有/無),
 *                            table/graph/figure(테두리 없는 표·그래프·그림, 항상 위에 제목),
 *                            note(단서: ※ * 등 주의 기호로 시작하는 문장), formula(수식), mixed(혼합)
 *   선지부(group:'choices') : viewbox(보기박스: ㄱ. ㄴ. ㄷ. 식의 보기가 든 박스), choice(원숫자 선지)
 *
 * 입력은 pdfAnalyze.analyze()가 열(column)마다 모아둔 데이터(텍스트 줄, 잉크 프로파일, 선분/사각형)와
 * 이미 확정된 문제 박스(조각)들이다. 좌표는 전부 페이지 캔버스 픽셀(원점 좌상단).
 *
 * 100% 정확하지 않으므로 리뷰 화면의 "구성요소 보정"에서 사람이 고칠 수 있게 한다.
 */
const PDFStructure = (() => {
  const KINDS = {
    setStem:    { group: 'stem',    label: '세트 시작설문' },
    stem:       { group: 'stem',    label: '설문' },
    text:       { group: 'data',    label: '지문(문단)' },
    box_titled: { group: 'data',    label: '박스(제목有)' },
    box_plain:  { group: 'data',    label: '박스(제목無)' },
    table:      { group: 'data',    label: '표' },
    graph:      { group: 'data',    label: '그래프' },
    figure:     { group: 'data',    label: '그림' },
    formula:    { group: 'data',    label: '수식' },
    mixed:      { group: 'data',    label: '혼합' },
    note:       { group: 'data',    label: '단서' },
    viewbox:    { group: 'choices', label: '보기박스' },
    choice:     { group: 'choices', label: '선지' },
  };
  const GROUP_LABELS = { stem: '설문부', data: '자료부', choices: '선지부' };

  // 구성요소 분석을 적용하는 과목(요청: 언어논리/자료해석/상황판단만)
  const SUBJECT_RE = /(언어\s*논리|자료\s*해석|상황\s*판단)/;
  function isSupportedSubject(subject) { return SUBJECT_RE.test(subject || ''); }

  const CHOICE_MARKS = '①②③④⑤⑥⑦⑧⑨';
  const START_CHOICE_RE = /^\s*[①②③④⑤⑥⑦⑧⑨]/;
  const VIEW_ITEM_RE = /^\s*[ㄱ-ㅎ]\s*[.．]/;
  const NOTE_RE = /^\s*(?:[※*＊☆★▷▶]|주\s*[)）:：]|\*\))/;
  const FOOTNOTE_NUM_RE = /^\s*\d{1,2}\s*[)）]/;
  // 제목 꼴 "<표 1> ...", "<그림> ..." — 바로 뒤에 조사가 붙은 "<그림>과 <표>를 ..." 같은 문장은 제목이 아니다.
  const TITLE_RE = /^\s*[<〈＜《]\s*(표|그림|그래프|도표|지도|사진|도|차트)\s*\d*\s*[^>〉＞》]{0,80}[>〉＞》](?![과와는은를을이가의에서도로만])/;
  const BRACKET_TITLE_RE = /^\s*[<〈＜《]\s*[^>〉＞》]{1,14}[>〉＞》]\s*$/;
  const QUESTION_END_RE = /([?？]|[시라]오\s*\.|하라\s*\.)\s*$/;

  // ==================== 선/사각형 검출 (픽셀 기반) ====================

  function detectLines(ctx, xStart, xEnd, yTop, yBottom, lineH) {
    const x0 = Math.max(0, Math.floor(xStart));
    const w = Math.max(1, Math.floor(xEnd) - x0);
    const y0 = Math.max(0, Math.floor(yTop));
    const h = Math.max(1, Math.ceil(yBottom) - y0);
    let data;
    try { data = ctx.getImageData(x0, y0, w, h).data; } catch (e) { return { hSegs: [], vSegs: [], rects: [] }; }
    const dark = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < dark.length; i++, j += 4) dark[i] = (data[j] + data[j + 1] + data[j + 2]) < 675 ? 1 : 0;

    const minH = Math.max(30, Math.round(w * 0.10));
    const minV = Math.max(24, Math.round((lineH || 16) * 1.2));

    // 가로 선: 행마다 긴 어두운 연속 구간
    const hRuns = [];
    for (let y = 0; y < h; y++) {
      let s = -1;
      const o = y * w;
      for (let x = 0; x <= w; x++) {
        const d = x < w && dark[o + x];
        if (d) { if (s < 0) s = x; }
        else if (s >= 0) { if (x - s >= minH) hRuns.push({ y, a: s, b: x }); s = -1; }
      }
    }
    // 세로 선: 열마다 긴 어두운 연속 구간
    const vRuns = [];
    for (let x = 0; x < w; x++) {
      let s = -1;
      for (let y = 0; y <= h; y++) {
        const d = y < h && dark[y * w + x];
        if (d) { if (s < 0) s = y; }
        else if (s >= 0) { if (y - s >= minV) vRuns.push({ x, a: s, b: y }); s = -1; }
      }
    }

    let hSegs = mergeRuns(hRuns, 'y').map((g) => ({ y: y0 + (g.p0 + g.p1) / 2, th: g.p1 - g.p0 + 1, x0: x0 + g.a, x1: x0 + g.b }));
    let vSegs = mergeRuns(vRuns, 'x').map((g) => ({ x: x0 + (g.p0 + g.p1) / 2, th: g.p1 - g.p0 + 1, y0: y0 + g.a, y1: y0 + g.b }));
    hSegs = hSegs.filter((s) => s.th <= 6);
    vSegs = vSegs.filter((s) => s.th <= 6);

    // 같은 높이에서 제목 글자 때문에 끊긴 테두리 선을 하나로 잇는다
    hSegs = joinCollinear(hSegs, 'y', 'x0', 'x1', 2, w * 0.55);
    vSegs = joinCollinear(vSegs, 'x', 'y0', 'y1', 2, 10);

    const rects = buildRects(hSegs, vSegs, w, lineH || 16, yTop, yBottom);
    return { hSegs, vSegs, rects };
  }

  /** 인접한 줄(run)들을 이어 붙여 두께가 있는 선 하나로 만든다. key: 'y'(가로선) | 'x'(세로선) */
  function mergeRuns(runs, key) {
    const out = [];
    const open = [];
    runs.sort((r1, r2) => r1[key] - r2[key] || r1.a - r2.a);
    for (const r of runs) {
      let g = null;
      for (let i = open.length - 1; i >= 0; i--) {
        const c = open[i];
        if (r[key] - c.p1 > 1) { open.splice(i, 1); continue; }
        const ov = Math.min(c.b, r.b) - Math.max(c.a, r.a);
        if (ov > 0.6 * Math.min(c.b - c.a, r.b - r.a)) { g = c; break; }
      }
      if (g) { g.p1 = r[key]; g.a = Math.min(g.a, r.a); g.b = Math.max(g.b, r.b); }
      else { g = { p0: r[key], p1: r[key], a: r.a, b: r.b }; open.push(g); out.push(g); }
    }
    return out;
  }

  function joinCollinear(segs, posKey, aKey, bKey, posTol, maxGap) {
    const arr = segs.slice().sort((s, t) => s[posKey] - t[posKey] || s[aKey] - t[aKey]);
    const out = [];
    for (const s of arr) {
      const last = out[out.length - 1];
      if (last && Math.abs(last[posKey] - s[posKey]) <= posTol && s[aKey] - last[bKey] <= maxGap) {
        last[bKey] = Math.max(last[bKey], s[bKey]);
        last.th = Math.max(last.th, s.th);
      } else out.push({ ...s });
    }
    return out;
  }

  /** 위/아래 가로선 + 양옆 세로선이 있는 사각형을 찾고, 서로 맞닿은 사각형(표의 행들)은 하나로 합친다. */
  function buildRects(hSegs, vSegs, colW, lineH, cutTop, cutBottom) {
    const minW = colW * 0.40;
    const cands = hSegs.filter((s) => s.x1 - s.x0 >= minW).sort((a, b) => a.y - b.y);
    const rects = [];
    for (const T of cands) {
      for (const B of cands) {
        if (B.y <= T.y + lineH * 1.2) continue;
        if (Math.abs(B.x0 - T.x0) > 7 || Math.abs(B.x1 - T.x1) > 7) continue;
        const hasL = vSegs.some((v) => Math.abs(v.x - T.x0) <= 5 && v.y0 <= T.y + 6 && v.y1 >= B.y - 6);
        const hasR = vSegs.some((v) => Math.abs(v.x - T.x1) <= 5 && v.y0 <= T.y + 6 && v.y1 >= B.y - 6);
        if (hasL && hasR) { rects.push({ x: T.x0, y: T.y, w: T.x1 - T.x0, h: B.y - T.y, rows: 1 }); break; }
      }
    }
    // 맞닿은 사각형 합치기
    rects.sort((a, b) => a.y - b.y || a.x - b.x);
    const merged = [];
    for (const r of rects) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(last.x - r.x) <= 7 && Math.abs(last.w - r.w) <= 10 && Math.abs(last.y + last.h - r.y) <= 4) {
        last.h = r.y + r.h - last.y;
        last.rows += 1;
      } else merged.push({ ...r });
    }
    // 열/페이지 경계에서 잘려 위 또는 아래 테두리가 없는 "열린 박스"(예: 지문 박스가 다음 열로 이어지는 경우).
    // 좌우 세로선 쌍이 충분히 길고 한쪽 끝에 가로선이 있거나 열 경계까지 이어지면 박스로 본다.
    const vs = vSegs.filter((v) => v.y1 - v.y0 >= lineH * 3).sort((a, b) => a.x - b.x);
    for (let i = 0; i < vs.length; i++) {
      for (let j = i + 1; j < vs.length; j++) {
        const A = vs[i], B = vs[j];
        if (B.x - A.x < minW) continue;
        if (Math.abs(A.y0 - B.y0) > 8 || Math.abs(A.y1 - B.y1) > 8) continue;
        const y0 = Math.min(A.y0, B.y0), y1 = Math.max(A.y1, B.y1);
        if (merged.some((m) => Math.abs(m.x - A.x) <= 8 && Math.abs(m.x + m.w - B.x) <= 8 && Math.min(m.y + m.h, y1) - Math.max(m.y, y0) > (y1 - y0) * 0.8)) continue;
        const topH = hSegs.some((h) => Math.abs(h.y - y0) <= 6 && h.x0 <= A.x + 8 && h.x1 >= B.x - 8);
        const botH = hSegs.some((h) => Math.abs(h.y - y1) <= 6 && h.x0 <= A.x + 8 && h.x1 >= B.x - 8);
        if (!topH && !botH && !(cutTop && y0 <= cutTop + 12) && !(cutBottom && y1 >= cutBottom - 12)) continue;
        merged.push({ x: A.x, y: y0, w: B.x - A.x, h: y1 - y0, rows: 1, open: topH ? (botH ? '' : 'bottom') : 'top' });
      }
    }
    // 이미 다른 사각형 안에 완전히 들어 있는 것은 제거(안쪽 칸)
    return merged.filter((r, i) => !merged.some((o, j) => j !== i && o.x <= r.x + 2 && o.y <= r.y + 2 &&
      o.x + o.w >= r.x + r.w - 2 && o.y + o.h >= r.y + r.h - 2 && (o.w * o.h) > (r.w * r.h) * 1.05));
  }

  // ==================== 유틸 ====================

  const lineTop = (l) => l.y - l.fs * 0.9;
  const lineBot = (l) => l.y + l.fs * 0.3;

  function unionOfLines(ls, padX = 3, padY = 2) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const l of ls) {
      x0 = Math.min(x0, l.x0); x1 = Math.max(x1, l.x1 || l.x0 + 20);
      y0 = Math.min(y0, lineTop(l)); y1 = Math.max(y1, lineBot(l));
    }
    return { x: x0 - padX, y: y0 - padY, w: (x1 - x0) + padX * 2, h: (y1 - y0) + padY * 2 };
  }

  function rectUnion(a, b) {
    const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
    const x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  const inRect = (l, r) => l.y >= r.y - 2 && l.y <= r.y + r.h + 2 && l.x0 >= r.x - 6 && l.x0 <= r.x + r.w;

  function textOf(ls) { return ls.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim(); }

  function inkFreeGapEnd(cd, y1, limit, gapPx) {
    // y1부터 아래로 훑어 gapPx 이상 흰 여백이 이어지기 직전(=블록의 끝)을 찾는다. limit을 넘지 않는다.
    const { inkRows, yOffset } = cd.inkProfile;
    const s = Math.max(0, Math.floor(y1 - yOffset));
    const e = Math.min(inkRows.length, Math.ceil(limit - yOffset));
    let lastInk = y1, blankStart = null;
    for (let i = s; i < e; i++) {
      const y = i + yOffset;
      if (inkRows[i]) { lastInk = y; blankStart = null; }
      else {
        if (blankStart === null) blankStart = y;
        if (y - blankStart >= gapPx) return lastInk + 3;
      }
    }
    return Math.max(lastInk + 3, Math.min(limit, y1 + 4));
  }

  function inkAmount(cd, y1, y2) {
    // [y1,y2) 안에서 잉크 행 개수
    const { inkRows, yOffset } = cd.inkProfile;
    let n = 0;
    for (let i = Math.max(0, Math.floor(y1 - yOffset)); i < Math.min(inkRows.length, Math.ceil(y2 - yOffset)); i++) if (inkRows[i]) n++;
    return n;
  }


  // ==================== 텍스트 본문(body) 만들기 — 텍스트 보기/혼합 보기에서 쓴다 ====================

  // 새 줄로 시작하는 항목 표지: ㄱ. / (가) / ① / 1. / ○ ※ 같은 불릿
  const NEWLINE_PAT = /^\s*(?:[ㄱ-ㅎ]\s*[.．]|\([가-힣ㄱ-ㅎ]\)|[①-⑨]|\d{1,2}\s*[.)]\s|[○●▶▷※*＊◦•]\s?)/;
  const TEXT_KINDS = new Set(['stem', 'setStem', 'text', 'note', 'viewbox', 'choice', 'box_titled', 'box_plain', 'mixed']);

  /** PDF의 시각적 줄바꿈(폭 때문에 꺾인 줄)은 이어 붙이고, 항목 표지로 시작하는 줄에서만 새 줄을 만든다. */
  function flowLines(lines) {
    const out = [];
    for (const l of lines) {
      const t = (l.text || '').trim();
      if (!t) continue;
      if (!out.length || NEWLINE_PAT.test(t)) out.push(t);
      else out[out.length - 1] += ' ' + t;
    }
    return out;
  }

  /** 박스/보기용: 항목 표지(ㄱ. ① 등)이거나, "앞 줄이 문장 끝(.?!)으로 끝났고 이 줄이 들여쓰기"면 새 줄/문단.
   *  (내어쓰기로 꺾인 줄은 앞 줄이 문장 중간에서 끝나므로 이어 붙는다) */
  function flowLinesSmart(lines) {
    const xs = lines.map((l) => l.x0).sort((a, b) => a - b);
    const margin = xs[Math.floor(xs.length * 0.3)] || 0;
    const fs = (lines[0] && lines[0].fs) || 14;
    const out = [];
    let prevEnd = true;
    for (const l of lines) {
      const t = (l.text || '').trim();
      if (!t) continue;
      const indented = l.x0 >= margin + fs * 0.6;
      if (!out.length || NEWLINE_PAT.test(t) || (indented && prevEnd)) out.push(t);
      else out[out.length - 1] += ' ' + t;
      prevEnd = /[.?!。”"')\]>]\s*$/.test(t);
    }
    return out;
  }

  function makeBody(lines, kind, lineH) {
    if (!TEXT_KINDS.has(kind) || !lines || !lines.length) return '';
    const out = (kind === 'box_titled' || kind === 'box_plain' || kind === 'viewbox' || kind === 'mixed')
      ? flowLinesSmart(lines)
      : flowLines(lines); // 설문/문단/단서/선지: 꺾인 줄은 이어 붙이고 항목 표지에서만 새 줄
    return out.join('\n').replace(/[ \t]+/g, ' ').slice(0, 8000);
  }

  // ==================== 한 조각(part) 분석 ====================

  /**
   * @param part   문제 박스(조각): {pageIndex,col,x,y,w,h,kind?,isOverflowPart,partIndex}
   * @param cd     그 열의 분석 데이터(structCols)
   * @param state  같은 문제의 앞 조각에서 넘어온 상태 {inChoices}
   * @param opts   {lastChoiceChar}
   */
  function analyzePart(part, cd, state, opts) {
    const lineH = cd.lineH || 16;
    const yEnd = part.y + part.h;
    const L = cd.lines.filter((l) => l.y >= part.y - 1 && l.y <= yEnd + 1);
    const out = [];
    const push = (kind, rect, extra = {}) => {
      const { lines: srcLines, ...rest } = extra;
      if (srcLines) rest.body = makeBody(srcLines, kind, lineH);
      out.push({ kind, group: KINDS[kind].group, x: rect.x, y: rect.y, w: rect.w, h: rect.h, ...rest });
    };
    if (!L.length) return out;

    const claimed = new Set(); // 구성요소로 이미 쓰인 줄
    L.forEach((l) => { if (/^[\s\-–—‐－−~]*\d+[\s\-–—‐－−~]*$/.test(l.text) || /^\s*\d+\s*쪽\s*$/.test(l.text)) claimed.add(l); });

    // ---- 1) 설문부 ----
    const isSet = part.kind === 'setIntro';
    let stemLines = [];
    if (isSet) {
      if (part.partIndex === 1 || !part.partIndex) {
        // 안내문: 첫 줄부터 문장이 끝나는 줄까지(마침표 또는 "[문 19～문 20]" 마커로 끝나는 줄, 최대 3줄).
        // 예) "※ 다음 <표>는 ... 자료이다.\n <표>를 보고 물음에 답하시오. [문 7～문 8]" → 2줄
        //     "[31～32] 다음은 ... 관한\n 자료이다. 다음 물음에 답하시오." → 2줄
        for (let i = 0; i < Math.min(3, L.length); i++) {
          stemLines.push(L[i]);
          if (/[.。\]]\s*$/.test(L[i].text.trim())) {
            // 첫 줄이 "…자료이다." 로 끝나도 둘째 줄에 마커가 이어지는 경우(※ 안내문 2줄)는 계속
            const next = L[i + 1];
            const hasMarker = stemLines.some((l) => /\[\s*(?:문\s*)?\d/.test(l.text));
            if (!hasMarker && next && /^\s*[<〈]/.test(next.text) && /\[\s*(?:문\s*)?\d+/.test(next.text) && (next.y - L[i].y) < lineH * 1.5) continue;
            break;
          }
        }
      }
    } else if ((part.partIndex || 1) === 1) {
      for (let i = 0; i < Math.min(8, L.length); i++) {
        stemLines.push(L[i]);
        if (QUESTION_END_RE.test(L[i].text.trim())) break;
        if (i === 7) stemLines = [L[0]]; // 끝을 못 찾으면 번호 줄만
      }
    }
    if (stemLines.length) {
      stemLines.forEach((l) => claimed.add(l));
      const r = unionOfLines(stemLines);
      push(isSet ? 'setStem' : 'stem', r, { text: textOf(stemLines), lines: stemLines });
    }
    const afterStemY = stemLines.length ? lineBot(stemLines[stemLines.length - 1]) : part.y;

    // ---- 2) 선지 시작 위치 ----
    let choicesStartY = Infinity;
    if (!isSet) {
      if (state.inChoices) choicesStartY = part.y;
      else {
        // 줄 맨 앞이 ① 인 줄들 중, 뒤에 ② 가 이어지는 "마지막" ① (본문 속 원문자 오탐 방지)
        const starts = L.filter((l) => !claimed.has(l) && /^\s*①/.test(l.text));
        let chosen = null;
        for (const s of starts) {
          const later = L.filter((l) => l.y > s.y && /^\s*[②③④⑤]/.test(l.text));
          const sameRow = /①.*②/.test(s.text);
          if (later.length || sameRow) chosen = s;
        }
        if (!chosen && starts.length) chosen = starts[starts.length - 1];
        if (!chosen) {
          // 이어짐 조각: ① 없이 ②/③.. 부터 나오는 경우
          const later = L.find((l) => !claimed.has(l) && START_CHOICE_RE.test(l.text));
          if (later) chosen = later;
        }
        if (chosen) choicesStartY = lineTop(chosen) - 1;
      }
    }

    // ---- 3) 테두리 박스 / 보기박스 ----
    const rects = cd.rects.filter((r) => r.y >= part.y - 3 && r.y + r.h <= yEnd + 3 && r.y >= afterStemY - lineH * 0.6);
    const usedRects = [];
    for (const r of rects) {
      const inner = L.filter((l) => inRect(l, r) && l.y > r.y - 4);
      const viewItems = inner.filter((l) => VIEW_ITEM_RE.test(l.text)).length;
      // 제목: 테두리 위/위에 걸친/안쪽 첫 줄 중 "<...>" 꼴의 짧은 줄
      const titleLine = L.find((l) => !claimed.has(l) && BRACKET_TITLE_RE.test(l.text.trim()) &&
        l.y >= r.y - lineH * 1.9 && l.y <= r.y + lineH * 1.6 &&
        (l.x0 + (l.x1 || l.x0)) / 2 > r.x + r.w * 0.25 && (l.x0 + (l.x1 || l.x0)) / 2 < r.x + r.w * 0.75);
      const tblTitle = L.find((l) => !claimed.has(l) && TITLE_RE.test(l.text) && l.y >= r.y - lineH * 2.3 && l.y <= r.y + 2);
      let bbox = { x: r.x, y: r.y, w: r.w, h: r.h };
      let title = titleLine ? titleLine.text.trim().replace(/\s+/g, '') : '';
      if (tblTitle && tblTitle.y < r.y - 2) {
        // 표/그림 제목이 테두리 위에 있으면 제목까지 포함
        const above = L.filter((l) => l.y >= tblTitle.y - 1 && l.y < r.y - 2);
        bbox = rectUnion(bbox, unionOfLines(above));
        title = tblTitle.text.trim();
      }
      inner.forEach((l) => claimed.add(l));
      if (tblTitle && tblTitle.y < r.y - 2) L.filter((l) => l.y >= tblTitle.y - 1 && l.y < r.y - 2).forEach((l) => claimed.add(l));
      if (titleLine) claimed.add(titleLine);
      if (viewItems >= 2) {
        push('viewbox', bbox, { title, text: textOf(inner), lines: inner });
      } else if (tblTitle && /표/.test(tblTitle.text.slice(0, 8))) {
        push('table', bbox, { title, text: textOf(inner), lines: inner });
      } else if (tblTitle) {
        push(graphOrFigure(cd, bbox, inner), bbox, { title, text: textOf(inner), lines: inner });
      } else if (r.rows >= 3 && !titleLine) {
        push('table', bbox, { title: '', text: textOf(inner), lines: inner });
      } else {
        push(title ? 'box_titled' : 'box_plain', bbox, { title, text: textOf(inner), lines: inner });
      }
      usedRects.push(r);
    }

    // ---- 4) 선지부 개별 선지 ----
    if (isFinite(choicesStartY)) {
      const chLines = L.filter((l) => !claimed.has(l) && l.y >= choicesStartY - 2 && !usedRects.some((r) => inRect(l, r)));
      const markers = collectMarkers(chLines, cd, part, opts);
      buildChoices(markers, chLines, cd, part, choicesStartY, yEnd, push, claimed);
      // 선지 영역 맨 위에서 다음 조각이 이어질 상태
      state.inChoices = true;
    }

    // ---- 5) 자료부: 남은 줄/여백을 블록으로 ----
    const dataEndY = isFinite(choicesStartY) ? choicesStartY : yEnd;
    const dataStartY = afterStemY;
    const dataLines = L.filter((l) => !claimed.has(l) && l.y > dataStartY - 2 && l.y < dataEndY + 0);
    // 보기(ㄱ. ㄴ.) 목록이 테두리 없이 놓인 경우도 보기박스
    const looseView = dataLines.filter((l) => VIEW_ITEM_RE.test(l.text));
    if (looseView.length >= 2 && !out.some((c) => c.kind === 'viewbox')) {
      const first = looseView[0];
      const idx0 = dataLines.indexOf(first);
      let start = idx0;
      if (idx0 > 0 && BRACKET_TITLE_RE.test(dataLines[idx0 - 1].text.trim())) start = idx0 - 1;
      // 보기 목록은 선지 시작(또는 자료부 끝)까지 이어짐
      const grp = dataLines.slice(start);
      grp.forEach((l) => claimed.add(l));
      push('viewbox', unionOfLines(grp), { title: '', text: textOf(grp), lines: grp });
    }
    const remaining = dataLines.filter((l) => !claimed.has(l));
    segmentData(remaining, cd, part, dataStartY, dataEndY, out, usedRects, push);

    return out;
  }

  function graphOrFigure(cd, bbox, innerLines) {
    // 축 눈금/데이터 라벨 같은 숫자 텍스트가 많으면 그래프, 아니면 그림
    const nums = innerLines.filter((l) => /^\s*[\d.,%()\-]+\s*$/.test(l.text.trim())).length;
    const numTokens = innerLines.reduce((n, l) => n + (l.text.match(/\d+(?:\.\d+)?/g) || []).length, 0);
    return (nums >= 3 || numTokens >= 8) ? 'graph' : 'figure';
  }

  function collectMarkers(chLines, cd, part) {
    // 원문자가 들어 있는 항목 위치(줄 안에 여러 개면 각각)
    const marks = [];
    const items = chLines;
    for (const l of items) {
      const t = l.text;
      for (let i = 0; i < t.length; i++) {
        const ch = t[i];
        if (CHOICE_MARKS.indexOf(ch) < 0) continue;
        // 줄 맨 앞이거나, 앞에 공백만 있거나, 같은 줄의 2번째 이후 선지(앞이 공백)
        const before = t.slice(0, i);
        if (before.trim() && !/\s$/.test(before)) continue;
        // 같은 줄 안에서의 x 위치: 문자 비율로 근사
        const frac = t.length ? i / t.length : 0;
        const x = i === 0 || !before.trim() ? l.x0 : l.x0 + (l.x1 - l.x0) * frac;
        marks.push({ ch, line: l, x, y: l.y });
      }
    }
    return marks;
  }

  function buildChoices(markers, chLines, cd, part, startY, yEnd, push, claimed) {
    if (!markers.length) {
      // 선지 마커를 못 찾았지만 선지 영역으로 판단된 경우(이어짐 조각): 영역 전체를 하나로
      const ls = chLines;
      if (ls.length) { ls.forEach((l) => claimed.add(l)); push('choice', unionOfLines(ls), { marker: '', text: textOf(ls), lines: ls }); }
      return;
    }
    // 행(y) 단위로 묶기
    const rows = [];
    for (const m of markers.slice().sort((a, b) => a.y - b.y || a.x - b.x)) {
      let row = rows.find((r) => Math.abs(r.y - m.y) <= 4);
      if (!row) { row = { y: m.y, ms: [] }; rows.push(row); }
      row.ms.push(m);
    }
    rows.sort((a, b) => a.y - b.y);
    rows.forEach((r) => r.ms.sort((a, b) => a.x - b.x));
    const lastLimit = Math.min(yEnd, cd.hardBottomY);
    // 첫 마커 위(선지 영역 맨 위)에 이어져 온 앞 선지의 내용이 있으면(이어짐 조각) 하나로 묶어 둔다
    const first = rows[0];
    if ((part.partIndex || 1) > 1 && lineTop(first.ms[0].line) - part.y > cd.lineH * 0.6) {
      const pre = chLines.filter((l) => l.y < first.ms[0].y - 2);
      const ytop = part.y;
      const yb = lineTop(first.ms[0].line) - 2;
      if (inkAmount(cd, ytop, yb) > 3) push('choice', { x: cd.xStart, y: ytop, w: cd.xEnd - cd.xStart, h: yb - ytop }, { marker: '', text: textOf(pre), lines: pre, cont: true });
    }
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      const nextRow = rows[ri + 1];
      const top = lineTop(row.ms[0].line) - 2;
      const bottomLimit = nextRow ? lineTop(nextRow.ms[0].line) - 2 : lastLimit;
      // 마지막 행은 실제 잉크가 끝나는 곳까지
      let bottom = bottomLimit;
      if (!nextRow) bottom = Math.min(lastLimit, inkFreeGapEnd(cd, top, lastLimit, cd.lineH * 2.4));
      else {
        // 선지 사이 내용(표/그래프)이 있으므로 다음 마커 직전까지
        bottom = bottomLimit;
      }
      for (let mi = 0; mi < row.ms.length; mi++) {
        const m = row.ms[mi];
        const left = mi === 0 ? Math.max(cd.xStart, m.x - 4) : m.x - 4;
        const right = mi + 1 < row.ms.length ? row.ms[mi + 1].x - 4 : cd.xEnd;
        const rect = { x: left, y: top, w: Math.max(10, right - left), h: Math.max(10, bottom - top) };
        const inside = chLines.filter((l) => l.y >= top && l.y <= bottom && l.x0 >= left - 6 && l.x0 < right);
        inside.forEach((l) => claimed.add(l));
        if (row.ms.length > 1) {
          // 한 줄에 선지가 여러 개("① ㄱ, ㄴ  ② ㄴ, ㄷ")면 이 선지의 몫만 잘라 쓴다(마커~다음 마커 사이).
          const t = m.line.text;
          const a = t.indexOf(m.ch);
          const nx = row.ms[mi + 1];
          const bIdx = nx && nx.line === m.line ? t.indexOf(nx.ch, a + 1) : -1;
          const piece = t.slice(a, bIdx > a ? bIdx : undefined).replace(/\s+/g, ' ').trim();
          push('choice', rect, { marker: m.ch, text: piece, body: piece });
        } else {
          push('choice', rect, { marker: m.ch, text: textOf(inside), lines: inside });
        }
      }
    }
  }

  // ---- 자료부(설문과 선지 사이의 나머지) 블록 분할 ----
  function segmentData(lines, cd, part, ys, ye, out, usedRects, push) {
    if (!lines.length) {
      // 텍스트가 없는데 잉크가 있으면 그림
      addUncoveredInk(cd, ys, ye, out, usedRects, push, []);
      return;
    }
    const lineH = cd.lineH || 16;
    const blocks = [];
    const isNoteStart = (l, prevKind) => NOTE_RE.test(l.text.trim()) ||
      (FOOTNOTE_NUM_RE.test(l.text.trim()) && (prevKind === 'table' || prevKind === 'graph' || prevKind === 'figure' || prevKind === 'note'));
    let i = 0;
    const plain = [];
    let curText = null;
    const flushText = () => { if (curText) { blocks.push(curText); curText = null; } };
    while (i < lines.length) {
      const l = lines[i];
      const t = l.text.trim();
      const top = lineTop(l);
      const prevKind = blocks.length ? blocks[blocks.length - 1].kind : null;
      if (TITLE_RE.test(t)) {
        flushText();
        // 표/그래프/그림: 제목 위쪽부터, 실제 잉크(선/도형 포함)가 이어지는 동안이 한 덩어리.
        // 다음 제목 줄이나 단서(※, 각주) 줄이 나오면 거기서 끊는다.
        let limit = ye;
        for (let j = i + 1; j < lines.length; j++) {
          const tj = lines[j].text.trim();
          if (TITLE_RE.test(tj) || NOTE_RE.test(tj)) { limit = lineTop(lines[j]) - 1; break; }
        }
        const end = inkFreeGapEnd(cd, top, limit, lineH * 1.05);
        const inside = [l];
        let j = i + 1;
        while (j < lines.length && lineTop(lines[j]) < end - 2 && lineTop(lines[j]) < limit) { inside.push(lines[j]); j++; }
        blocks.push({ kind: /표/.test(t.slice(0, 8)) ? 'table' : (/그래프/.test(t.slice(0, 8)) ? 'graph' : 'figure'), title: t, lines: inside, start: top, lastBottom: lineBot(inside[inside.length - 1]), end: Math.max(end, lineBot(inside[inside.length - 1])) });
        i = j;
      } else if (isNoteStart(l, prevKind)) {
        flushText();
        const noteLines = [l];
        let j = i + 1;
        while (j < lines.length) {
          const nl = lines[j];
          const gap = lineTop(nl) - lineBot(noteLines[noteLines.length - 1]);
          if (TITLE_RE.test(nl.text.trim())) break;
          if (isNoteStart(nl, 'note') && gap < lineH * 0.9) { noteLines.push(nl); j++; continue; }
          // 이어 쓴 줄(들여쓰기) 또는 분수식처럼 겹쳐 있는 줄
          if (gap < lineH * 0.35 || (gap < lineH * 0.7 && nl.x0 > noteLines[0].x0 + 2)) { noteLines.push(nl); j++; continue; }
          break;
        }
        blocks.push({ kind: 'note', title: '', lines: noteLines, start: top, lastBottom: lineBot(noteLines[noteLines.length - 1]), end: lineBot(noteLines[noteLines.length - 1]) });
        i = j;
      } else {
        plain.push(l);
        i++;
      }
    }

    // 제목 없는 그림/도형: 텍스트 줄로 설명되지 않는 잉크가 이어지는 영역(예: 타원 궤도 그림 + A,B,X 라벨)을
    // 그림으로 묶고, 그 영역에 걸친 짧은 라벨 줄들은 그림에 흡수한다.
    const blockRanges = blocks.map((b) => [b.start, b.end]);
    const figs = findFigureRegions(cd, plain, ys, ye, blockRanges, [...usedRects.map((r) => [r.y, r.y + r.h]), ...out.map((c) => [c.y, c.y + c.h])]);
    const textLines = plain.filter((l) => !figs.some((f) => l.y >= f.y0 - 2 && l.y <= f.y1 + 2));
    for (const f of figs) {
      const absorbed = plain.filter((l) => l.y >= f.y0 - 2 && l.y <= f.y1 + 2);
      blocks.push({ kind: 'figure', title: '', lines: absorbed, start: f.y0, end: f.y1, untitled: true });
    }
    for (const l of textLines) {
      const top = lineTop(l);
      const gap = curText ? top - curText.lastBottom : 0;
      const nearFig = figs.some((f) => Math.abs(top - f.y1) < 1 && false);
      if (curText && (gap > lineH * 1.7 || nearFig)) flushText();
      if (!curText) curText = { kind: 'text', title: '', lines: [], start: top, lastBottom: 0 };
      curText.lines.push(l);
      curText.lastBottom = lineBot(l);
      curText.end = curText.lastBottom;
    }
    flushText();

    blocks.sort((p, q) => p.start - q.start);
    // 텍스트 블록은 문단 단위로 쪼갠다(첫 줄 들여쓰기 기준)
    const finals = [];
    for (const b of blocks) {
      if (b.kind === 'text') {
        for (const para of splitParagraphs(b.lines, lineH)) finals.push({ kind: 'text', lines: para, title: '' });
      } else finals.push(b);
    }

    // 분수식처럼 단서(※) 줄 바로 위/아래에 붙은 짧은 텍스트 조각은 단서에 합친다
    for (let k = 0; k < finals.length; k++) {
      const f = finals[k];
      if (f.kind !== 'text' || f.lines.length > 2 || textOf(f.lines).length > 24) continue;
      const nx = finals[k + 1];
      const pv = finals[k - 1];
      const fTop = lineTop(f.lines[0]), fBot = lineBot(f.lines[f.lines.length - 1]);
      if (nx && nx.kind === 'note' && lineTop(nx.lines[0]) - fBot < lineH * 0.5) { nx.lines = f.lines.concat(nx.lines); finals.splice(k, 1); k--; }
      else if (pv && pv.kind === 'note' && fTop - lineBot(pv.lines[pv.lines.length - 1]) < lineH * 0.5) { pv.lines = pv.lines.concat(f.lines); finals.splice(k, 1); k--; }
    }
    const covered = [];
    for (const b of finals) {
      if (b.kind === 'text') {
        const r = unionOfLines(b.lines);
        push('text', r, { text: textOf(b.lines), lines: b.lines });
        covered.push([r.y, r.y + r.h]);
      } else if (b.kind === 'note') {
        const r = unionOfLines(b.lines);
        push('note', r, { text: textOf(b.lines), lines: b.lines });
        covered.push([r.y, r.y + r.h]);
      } else {
        const r = b.lines.length ? unionOfLines(b.lines) : { x: cd.xStart, y: b.start, w: cd.xEnd - cd.xStart, h: (b.end || b.start + 10) - b.start };
        if (b.untitled) { r.y = Math.min(r.y, b.start); }
        const y2 = Math.max(r.y + r.h, b.end || 0);
        const rect = { x: Math.min(r.x, cd.xStart + 2), y: r.y, w: Math.max(r.w, cd.xEnd - cd.xStart - 4), h: y2 - r.y };
        // 표/그림은 폭을 열 전체로(도표는 보통 열 폭을 씀)
        rect.x = cd.xStart; rect.w = cd.xEnd - cd.xStart;
        let kind = b.kind;
        if (kind === 'figure') kind = graphOrFigure(cd, rect, b.lines);
        push(kind, rect, { title: b.title, text: textOf(b.lines), lines: b.lines });
        covered.push([rect.y, rect.y + rect.h]);
      }
    }
    addUncoveredInk(cd, ys, ye, out, usedRects, push, covered);
  }

  function splitParagraphs(lines, lineH) {
    if (lines.length <= 1) return [lines];
    // 왼쪽 여백 = 줄 시작 x의 최빈 구간
    const xs = lines.map((l) => l.x0).sort((a, b) => a - b);
    const margin = xs[Math.floor(xs.length * 0.3)];
    const fs = lines[0].fs || 14;
    const paras = [];
    let cur = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const indented = l.x0 >= margin + fs * 0.6;
      const bigGap = i > 0 && (lineTop(l) - lineBot(lines[i - 1])) > lineH * 0.55;
      if (cur.length && (indented || bigGap)) { paras.push(cur); cur = []; }
      cur.push(l);
    }
    if (cur.length) paras.push(cur);
    // 들여쓰기가 하나도 없고 간격도 없으면 통째로 한 문단
    return paras.length ? paras : [lines];
  }

  /**
   * 텍스트 줄(살짝 여유를 둔 세로 범위)과 이미 잡힌 블록으로 설명되지 않는 잉크가 세로로 이어지는 영역을 찾는다.
   * 그림/도형(타원 궤도, 지도 등)은 텍스트 줄 사이사이에 도형 잉크가 남는 반면, 일반 문단은 줄 사이가 비어 있다.
   */
  function findFigureRegions(cd, plainLines, ys, ye, blockRanges, otherRanges) {
    const lineH = cd.lineH || 16;
    const { inkRows, yOffset } = cd.inkProfile;
    const explained = [...blockRanges, ...otherRanges, ...plainLines.map((l) => [lineTop(l) - 1, lineBot(l) + 1])];
    const isExplained = (y) => explained.some(([a, b]) => y >= a && y <= b);
    const regions = [];
    let cur = null;
    for (let y = Math.floor(ys); y < Math.ceil(ye); y++) {
      const i = Math.floor(y - yOffset);
      const unexplainedInk = i >= 0 && i < inkRows.length && inkRows[i] && !isExplained(y);
      if (unexplainedInk) {
        if (!cur) cur = { y0: y, y1: y, rows: 0 };
        else if (y - cur.y1 > lineH * 1.6) { regions.push(cur); cur = { y0: y, y1: y, rows: 0 }; }
        cur.y1 = y; cur.rows++;
      }
    }
    if (cur) regions.push(cur);
    // 충분히 크고(2줄 이상 높이) 잉크가 꽤 있는 영역만 그림으로
    return regions.filter((r) => (r.y1 - r.y0) >= lineH * 2 && r.rows >= lineH * 1.2).map((r) => {
      // 영역 위아래에 걸친 라벨 줄까지 넓힌다
      let y0 = r.y0, y1 = r.y1;
      for (const l of plainLines) {
        const t = lineTop(l), b = lineBot(l);
        if (b >= y0 - lineH * 0.9 && t <= y1 + lineH * 0.9 && (l.text.trim().length <= 8 || (t >= y0 && b <= y1))) { y0 = Math.min(y0, t); y1 = Math.max(y1, b); }
      }
      return { y0, y1 };
    });
  }

  /** 텍스트로 설명되지 않는 잉크(그림/그래프 본체, 제목 없는 도형)를 그림 구성요소로 */
  function addUncoveredInk(cd, ys, ye, out, usedRects, push, coveredRanges) {
    const lineH = cd.lineH || 16;
    const { inkRows, yOffset } = cd.inkProfile;
    const blocked = [...coveredRanges, ...usedRects.map((r) => [r.y, r.y + r.h]), ...out.map((c) => [c.y, c.y + c.h])];
    const isBlocked = (y) => blocked.some(([a, b]) => y >= a - 1 && y <= b + 1);
    let runStart = null, last = null;
    const flushRun = () => {
      if (runStart !== null && last - runStart >= lineH * 2.5) {
        push('figure', { x: cd.xStart, y: runStart - 2, w: cd.xEnd - cd.xStart, h: last - runStart + 6 }, { title: '', text: '' });
      }
      runStart = null;
    };
    for (let y = Math.floor(ys); y < ye; y++) {
      const i = Math.floor(y - yOffset);
      const ink = i >= 0 && i < inkRows.length && inkRows[i] && !isBlocked(y);
      if (ink) { if (runStart === null) runStart = y; last = y; }
      else if (runStart !== null && y - last > lineH * 0.8) flushRun();
    }
    flushRun();
  }

  // ==================== 문서 전체 ====================

  /** 박스(조각)가 놓인 열의 분석 데이터. 사용자가 박스를 옮겼을 수 있으니 실제 위치(가운데 x)로 찾는다. */
  function colDataFor(structCols, part) {
    const cx = part.x + part.w / 2;
    const cds = Object.values(structCols).filter((d) => d.pageIndex === part.pageIndex);
    return cds.find((d) => cx >= d.xStart && cx <= d.xEnd) || structCols[part.pageIndex + '_' + (part.col || 0)] || cds[0] || null;
  }

  /** 문제 박스들의 구성요소를 전부 계산해 평면 목록으로 돌려준다.
   *  반환 항목: {id, qnum|null, setRange|null, pageIndex, x,y,w,h, group, kind, title, text, marker?} */
  function analyzeAll(boxes, structCols, opts = {}) {
    const groups = new Map();
    for (const b of boxes) {
      const key = b.kind === 'setIntro' ? 'S' + b.setRange.join('-') : 'Q' + b.qnum;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }
    const all = [];
    for (const [key, parts] of groups) {
      const colIdx = (p) => { const d = colDataFor(structCols, p); return d ? d.col : 0; };
      parts.sort((a, b) => a.pageIndex - b.pageIndex || colIdx(a) - colIdx(b) || a.y - b.y);
      const state = { inChoices: false };
      parts.forEach((part) => {
        const cd = colDataFor(structCols, part);
        if (!cd) return;
        let comps = [];
        try { comps = analyzePart(part, cd, state, opts); } catch (err) { console.error('구성요소 분석 오류', key, err); }
        comps.sort((a, b) => a.y - b.y || a.x - b.x);
        comps.forEach((c, k) => {
          all.push({
            id: key + '_' + part.partIndex + '_' + k,
            qnum: part.kind === 'setIntro' ? null : part.qnum,
            setRange: part.kind === 'setIntro' ? part.setRange.slice() : null,
            pageIndex: part.pageIndex,
            title: '', text: '',
            ...c,
          });
        });
      });
    }
    return all;
  }

  /** 한 문제(또는 세트 공통지문)의 구성요소만 다시 계산 — 리뷰 화면의 "재분석" 버튼용 */
  function analyzeOne(parts, structCols, opts = {}) {
    return analyzeAll(parts, structCols, opts);
  }

  return { KINDS, GROUP_LABELS, isSupportedSubject, detectLines, analyzeAll, analyzeOne };
})();

window.PDFStructure = PDFStructure;
