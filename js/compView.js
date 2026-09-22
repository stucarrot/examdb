/* compView.js — 문제 본문 뷰어 (문제 뷰어 · 문제풀이 공용)
 *
 * - 여러 조각(이미지)으로 저장된 문제도 **하나의 세로 열**로 이어 붙여 위아래로 스크롤한다
 *   (세트 공통 지문 조각은 저장 시 하위 문제마다 이미 들어 있음).
 * - 구성요소(q.components)가 있으면 구성요소별 "블록"으로 나눠 보여주고, **블록마다 이미지/텍스트를 따로**
 *   고를 수 있다(혼합 보기). 예: 표는 이미지, 선지는 텍스트.
 *   구성요소가 없는 문제는 조각 이미지를 그대로 세로로 잇고, 텍스트 선지가 있으면 설문/선지 텍스트 블록을 쓴다.
 * - 이미지 블록은 조각 이미지를 구성요소 좌표대로 잘라(crop) 보여준다. 모든 조각을 같은 배율로 그려서
 *   글자 크기가 조각마다 달라 보이지 않게 한다.
 *
 * 사용:
 *   const ctl = await CompView.mount(container, q, urls, { choices, defaultMode:'image'|'text', zoom });
 *   ctl.blocks / ctl.setDefaultMode(m) / ctl.setZoom(z) / ctl.scrollToBlock(id) / ctl.signature()
 */
const CompView = (() => {
  const TEXT_OK = new Set(['stem', 'setStem', 'text', 'note', 'viewbox', 'choice', 'box_titled', 'box_plain', 'mixed']);
  const overridesByQ = new Map(); // 문제 id → { 블록id: 'image'|'text' } (세션 동안만 기억)
  const GAP_MIN = 0.05;           // 구성요소가 덮지 못한 세로 띠가 조각 높이의 이만큼 이상이면 이미지 블록으로 보충

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function loadSize(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
      img.onerror = () => resolve({ w: 1, h: 1 });
      img.src = url;
    });
  }

  // ==================== 블록 만들기 ====================

  /** 문제 → 표시 블록 목록. 각 블록: {id, kind, group, part, x,y,w,h(0~1, 조각 기준), textOk, body, marker, title, comp} */
  function buildBlocks(q, sizes, choices) {
    const comps = Array.isArray(q.components) ? q.components : [];
    const blocks = [];
    if (comps.length) {
      for (let p = 0; p < sizes.length; p++) {
        const items = comps.filter((c) => c.part === p).map((c) => ({
          id: c.id, kind: c.kind, group: c.group, part: p, x: c.x, y: c.y, w: c.w, h: c.h,
          textOk: TEXT_OK.has(c.kind) && !!c.body, body: c.body || '', marker: c.marker || '', title: c.title || '', comp: c,
        }));
        items.sort((a, b) => a.y - b.y || a.x - b.x);
        // 구성요소가 덮지 못한 세로 띠(분석이 놓친 내용일 수 있음)는 이미지 블록으로 채운다
        const covered = items.map((b) => [b.y, b.y + b.h]).sort((a, b) => a[0] - b[0]);
        const gaps = [];
        let cur = 0;
        for (const [a, b] of covered) {
          if (a - cur >= GAP_MIN) gaps.push([cur, a]);
          cur = Math.max(cur, b);
        }
        if (1 - cur >= GAP_MIN) gaps.push([cur, 1]);
        gaps.forEach(([a, b], k) => items.push({
          id: `gap${p}_${k}`, kind: 'gap', group: 'data', part: p, x: 0, y: a, w: 1, h: b - a,
          textOk: false, body: '', marker: '', title: '', comp: null,
        }));
        items.sort((a, b) => a.y - b.y || a.x - b.x);
        items.forEach((b) => blocks.push(b));
      }
      return blocks;
    }
    // 구성요소 없음: 조각 이미지를 통째로 잇는다
    for (let p = 0; p < sizes.length; p++) {
      blocks.push({ id: `p${p}`, kind: 'part', group: 'data', part: p, x: 0, y: 0, w: 1, h: 1, textOk: false, body: '', marker: '', title: '', comp: null });
    }
    // 텍스트 선지가 있는 옛 문제: 설문 / 선지 텍스트 블록(이미지 블록들은 "이미지로" 볼 때만 쓰임)
    if (q.hasTextChoices && (q.stemFullText || (choices && choices.length))) {
      blocks.legacyText = [];
      if (q.stemFullText) blocks.legacyText.push({ id: 'ltstem', kind: 'text', group: 'stem', part: 0, textOk: true, body: q.stemFullText, marker: '', title: '' }); // 옛 데이터는 설문과 지문이 한 덩어리라 굵게 하지 않는다
      (choices || []).forEach((c, i) => blocks.legacyText.push({
        id: 'ltc' + i, kind: 'choice', group: 'choices', part: 0, textOk: true,
        body: (window.PDFAnalyze ? PDFAnalyze.markerToPlain(c.marker) : c.marker) + ' ' + c.text, marker: c.marker, title: '',
      }));
    }
    return blocks;
  }

  // ==================== 텍스트 서식 ====================

  function prettify(t) { return window.PDFAnalyze ? PDFAnalyze.prettifyMarkers(t) : t; }

  function textHtml(b) {
    const lines = String(b.body || '').split('\n').filter((l) => l.trim());
    if (b.kind === 'choice') {
      // 선지: 표지(①)는 앞에 따로, 나머지 줄은 아래에 이어서
      const first = lines[0] || '';
      const m = first.match(/^\s*([①-⑨])\s*(.*)$/);
      const marker = m ? (window.PDFAnalyze ? PDFAnalyze.markerToPlain(m[1]) : m[1]) : '';
      const rest = [m ? m[2] : first].concat(lines.slice(1));
      return `<div class="cvChoice"><span class="cvMarker">${esc(marker)}</span><span class="cvChoiceBody">${rest.map((l) => `<div>${esc(prettify(l))}</div>`).join('')}</span></div>`;
    }
    let titleHtml = '';
    if (b.kind === 'viewbox' || b.kind === 'box_titled') {
      if (lines.length && /^\s*[<〈＜《].{1,14}[>〉＞》]\s*$/.test(lines[0])) titleHtml = `<div class="cvBoxTitle">${esc(lines.shift())}</div>`;
    }
    return titleHtml + lines.map((l) => `<p>${esc(prettify(l))}</p>`).join('');
  }

  // ==================== 마운트 ====================

  async function mount(container, q, urls, opts = {}) {
    const sizes = await Promise.all(urls.map(loadSize));
    const choices = opts.choices || [];
    const blocks = buildBlocks(q, sizes, choices);
    const legacyText = blocks.legacyText || null;
    const overrides = overridesByQ.get(q.id) || {};
    overridesByQ.set(q.id, overrides);
    const st = { defaultMode: opts.defaultMode || 'image', zoom: opts.zoom || 1 };
    const maxW = Math.max(1, ...sizes.map((s) => s.w));

    const column = document.createElement('div');
    column.className = 'cvColumn';
    container.innerHTML = '';
    container.classList.add('cvScroller');
    container.appendChild(column);

    /** 지금 이 블록을 어느 방식으로 보이는지 */
    function modeOf(b) {
      if (legacyText) return st.defaultMode === 'text' ? 'text' : 'image';
      if (!b.textOk) return 'image';
      return overrides[b.id] || st.defaultMode;
    }

    function imageEl(b) {
      const size = sizes[b.part] || { w: 1, h: 1 };
      const scale = size.w / maxW;
      const d = document.createElement('div');
      d.className = 'cvBlock cvImg' + (b.kind === 'gap' ? ' cvGap' : '');
      d.dataset.cid = b.id;
      d.style.width = (b.w * scale * 100) + '%';
      d.style.aspectRatio = `${b.w * size.w} / ${b.h * size.h}`;
      const img = document.createElement('img');
      img.src = urls[b.part];
      img.draggable = false;
      img.alt = '';
      img.style.width = (100 / b.w) + '%';
      img.style.left = (-b.x / b.w * 100) + '%';
      img.style.top = (-b.y / b.h * 100) + '%';
      d.appendChild(img);
      return d;
    }

    function textEl(b) {
      const d = document.createElement('div');
      d.className = 'cvBlock cvText k-' + b.kind + ' g-' + b.group;
      d.dataset.cid = b.id;
      d.innerHTML = `<div class="cvBody">${textHtml(b)}</div>`;
      if (window.TextViewPrefs) TextViewPrefs.applyTo(d);
      return d;
    }

    function blockEl(b) {
      const mode = modeOf(b);
      const d = mode === 'text' ? textEl(b) : imageEl(b);
      d.classList.toggle('cvSel', column.dataset.sel === b.id);
      if (b.textOk && !legacyText) {
        const t = document.createElement('button');
        t.type = 'button';
        t.className = 'cvToggle';
        t.textContent = mode === 'text' ? '🖼' : '🔤';
        t.title = mode === 'text' ? '이 부분을 이미지로 보기' : '이 부분을 텍스트로 보기';
        t.addEventListener('click', (e) => {
          e.stopPropagation();
          overrides[b.id] = mode === 'text' ? 'image' : 'text';
          replaceBlock(b);
          changed();
        });
        t.addEventListener('mousedown', (e) => e.stopPropagation());
        d.appendChild(t);
      }
      return d;
    }

    function replaceBlock(b) {
      const old = column.querySelector(`[data-cid="${cssEsc(b.id)}"]`);
      if (!old) return;
      old.replaceWith(blockEl(b));
    }

    function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"'); }

    /** 같은 가로줄에 나란히 놓인 블록(한 줄에 선지가 여러 개 등)은 한 행으로 묶는다 */
    function groupRows(list) {
      const rows = [];
      for (const b of list) {
        const last = rows[rows.length - 1];
        if (last && last[0].part === b.part && last.every((o) => overlapY(o, b) >= 0.6 && (b.x >= o.x + o.w - 0.01))) last.push(b);
        else rows.push([b]);
      }
      return rows;
    }
    function overlapY(a, b) {
      const lo = Math.max(a.y, b.y), hi = Math.min(a.y + a.h, b.y + b.h);
      return Math.max(0, hi - lo) / Math.max(0.0001, Math.min(a.h, b.h));
    }

    function renderAll() {
      column.innerHTML = '';
      column.style.width = (st.zoom * 100) + '%';
      const list = (legacyText && st.defaultMode === 'text') ? legacyText : blocks;
      if (legacyText && st.defaultMode === 'text') {
        list.forEach((b) => column.appendChild(blockEl(b)));
        return;
      }
      for (const row of groupRows(list)) {
        if (row.length === 1) { column.appendChild(blockEl(row[0])); continue; }
        const wrap = document.createElement('div');
        wrap.className = 'cvRow';
        row.forEach((b) => {
          const be = blockEl(b);
          const size = sizes[b.part] || { w: 1 };
          if (be.classList.contains('cvText')) { be.style.width = (b.w * (size.w / maxW) * 100) + '%'; be.style.alignSelf = 'flex-start'; }
          wrap.appendChild(be);
        });
        column.appendChild(wrap);
      }
    }

    function changed() { if (opts.onChange) opts.onChange(ctl); }

    const ctl = {
      blocks,
      column,
      container,
      hasText: !!legacyText || blocks.some((b) => b.textOk),
      /** 구성요소가 있는 문제인지(목차/혼합 보기 사용 가능) */
      hasComponents: !legacyText && blocks.some((b) => b.comp),
      setDefaultMode(m, reset) { st.defaultMode = m; if (reset) Object.keys(overrides).forEach((k) => delete overrides[k]); renderAll(); changed(); },
      getDefaultMode() { return st.defaultMode; },
      setZoom(z) { st.zoom = z; column.style.width = (z * 100) + '%'; changed(); },
      clearOverrides() { Object.keys(overrides).forEach((k) => delete overrides[k]); renderAll(); changed(); },
      isMixed() {
        const modes = new Set(blocks.filter((b) => b.textOk).map((b) => modeOf(b)));
        return modes.size > 1;
      },
      /** 필기(Drawing)의 저장 키: 전부 이미지 = 'image', 전부 텍스트 = 'text', 섞임 = 'cv:…' */
      signature() {
        if (legacyText && st.defaultMode === 'text') return 'text';
        const sig = blocks.map((b) => (modeOf(b) === 'text' ? 't' : 'i')).join('');
        if (!sig.includes('t')) return 'image';
        if (!blocks.some((b) => !b.textOk) && !sig.includes('i')) return 'text';
        let h = 0;
        for (let i = 0; i < sig.length; i++) h = ((h * 31) + sig.charCodeAt(i)) | 0;
        return 'cv:' + sig.length + ':' + (h >>> 0).toString(36);
      },
      blockEl(id) { return column.querySelector(`[data-cid="${cssEsc(id)}"]`); },
      select(id) {
        column.dataset.sel = id || '';
        column.querySelectorAll('.cvSel').forEach((n) => n.classList.remove('cvSel'));
        const el = id ? ctl.blockEl(id) : null;
        if (el) el.classList.add('cvSel');
      },
      /** 블록이 스크롤 영역 맨 위쪽에 오도록 이동(작은 여백을 둠) */
      scrollToBlock(id) {
        const el = ctl.blockEl(id);
        if (!el) return;
        ctl.select(id);
        const cr = container.getBoundingClientRect();
        const er = el.getBoundingClientRect();
        container.scrollTo({ top: Math.max(0, container.scrollTop + (er.top - cr.top) - 8), behavior: 'auto' });
      },
      refreshPrefs() {
        column.querySelectorAll('.cvText').forEach((n) => { if (window.TextViewPrefs) TextViewPrefs.applyTo(n); });
      },
      destroy() { column.remove(); container.classList.remove('cvScroller'); },
    };
    renderAll();
    return ctl;
  }

  return { mount, TEXT_OK };
})();

window.CompView = CompView;
