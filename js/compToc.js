/* compToc.js — 문제 구성요소 플로팅 목차 (문제 뷰어 · 문제풀이 · 텍스트/이미지/혼합 모든 보기에서 공용)
 *
 * 그리기 툴바처럼 켜고 끌 수 있고(토글 버튼),
 *  - 미니 모드(기본): 화면 왼쪽에 '설문' '박스1' '보기' '선지' 처럼 유형만 작은 글씨로 세로로 떠 있는 목차. 누르면 그 요소로 이동.
 *  - 확장 모드: ⤢ 를 누르면 큰 사이드바(구성요소별 내용 미리보기 포함)로 펼쳐진다.
 * 켬/끔, 미니/확장 상태는 기기에 기억한다(라이브러리·문제풀이 공통).
 */
const CompToc = (() => {
  const KEY_ON = 'compTocOn';
  const KEY_EXP = 'compTocExpanded';
  const GROUP_LABEL = { stem: '설문부', data: '자료부', choices: '선지부' };
  const KIND_NAME = {
    setStem: '세트 시작설문', stem: '설문', text: '지문', box_titled: '박스', box_plain: '박스',
    table: '표', graph: '그래프', figure: '그림', formula: '수식', mixed: '혼합', note: '단서', viewbox: '보기박스', choice: '선지',
  };
  // 미니 모드 짧은 이름 / 번호를 붙일 종류
  const MINI_NAME = { setStem: '세트설문', stem: '설문', text: '지문', box_titled: '박스', box_plain: '박스', table: '표', graph: '그래프', figure: '그림', formula: '수식', mixed: '혼합', note: '단서', viewbox: '보기', choice: '선지' };
  const NUMBERED = new Set(['text', 'box_titled', 'box_plain', 'table', 'graph', 'figure', 'formula', 'mixed']);

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v === '1'; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v ? '1' : '0'); } catch (e) { /* 무시 */ } },
  };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  /**
   * @param host 목차가 떠 있을 영역(position:relative 여야 함 — 보통 뷰어 래퍼)
   * @param toggleBtn 켜고 끄는 버튼(없으면 null)
   */
  function create(host, toggleBtn) {
    const panel = document.createElement('div');
    panel.className = 'ctoc hidden';
    host.appendChild(panel);

    let ctl = null;
    let on = store.get(KEY_ON, true);
    let expanded = store.get(KEY_EXP, false);
    let items = [];       // 구성요소 블록(gap/part 제외)
    let activeId = null;
    let scrollBound = null;
    let raf = 0;

    /** 종류별 번호를 붙인 라벨 계산 */
    function buildItems() {
      items = ctl ? ctl.blocks.filter((b) => b.comp) : [];
      const total = {}, seen = {};
      items.forEach((b) => { const k = MINI_NAME[b.kind]; total[k] = (total[k] || 0) + 1; });
      items.forEach((b) => {
        const k = MINI_NAME[b.kind] || b.kind;
        seen[k] = (seen[k] || 0) + 1;
        b.tocLabel = (NUMBERED.has(b.kind) || total[k] > 1) && b.kind !== 'choice' ? k + seen[k] : k;
      });
    }

    function render() {
      const has = !!ctl && items.length > 0;
      if (toggleBtn) { toggleBtn.classList.toggle('hidden', !has); toggleBtn.classList.toggle('active', has && on); }
      panel.classList.toggle('hidden', !(has && on));
      panel.classList.toggle('expanded', expanded);
      // 미니 목차가 본문 왼쪽 글자를 가리지 않게 스크롤 영역 왼쪽에 자리를 비운다(확장 목차는 임시로 덮는 사이드바)
      if (ctl && ctl.container) ctl.container.classList.toggle('ctocGutter', has && on && !expanded);
      if (!has || !on) return;
      panel.innerHTML = expanded ? expandedHtml() : miniHtml();
      panel.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => choose(b.dataset.id)));
      const ex = panel.querySelector('[data-act="expand"]');
      if (ex) ex.addEventListener('click', () => { expanded = !expanded; store.set(KEY_EXP, expanded); render(); });
      const off = panel.querySelector('[data-act="close"]');
      if (off) off.addEventListener('click', () => setEnabled(false));
      syncActive();
    }

    function miniHtml() {
      // 선지는 개별이 아니라 '선지' 하나로(첫 선지로 이동)
      const chips = [];
      let choiceDone = false;
      items.forEach((b) => {
        if (b.kind === 'choice') {
          if (choiceDone) return;
          choiceDone = true;
        }
        chips.push(`<button type="button" class="ctocChip g-${b.group} k-${b.kind}" data-id="${esc(b.id)}" data-group="${b.kind === 'choice' ? 'choices' : ''}">${esc(b.tocLabel)}</button>`);
      });
      return `<button type="button" class="ctocHead" data-act="expand" title="목차 크게 보기">⤢</button>${chips.join('')}`;
    }

    function expandedHtml() {
      let html = '<div class="ctocTop"><b>구성요소 목차</b><span><button type="button" class="ctocIcon" data-act="expand" title="작게(미니)">⤡</button><button type="button" class="ctocIcon" data-act="close" title="목차 끄기">✕</button></span></div>';
      ['stem', 'data', 'choices'].forEach((g) => {
        const list = items.filter((b) => b.group === g);
        if (!list.length) return;
        html += `<div class="ctocGroup g-${g}">${GROUP_LABEL[g]}</div>`;
        list.forEach((b) => {
          const name = b.kind === 'choice' ? '선지 ' + (b.marker ? (window.PDFAnalyze ? PDFAnalyze.markerToPlain(b.marker) : b.marker) : '') : b.tocLabel;
          const detail = (b.title || b.comp.text || '').replace(/\s+/g, ' ').trim().replace(/^[①-⑨]\s*/, '').slice(0, 30);
          html += `<button type="button" class="ctocRow g-${b.group} k-${b.kind}" data-id="${esc(b.id)}"><span class="ctocDot"></span><span class="ctocName">${esc(name)}</span>${detail ? `<span class="ctocDetail">${esc(detail)}</span>` : ''}</button>`;
        });
      });
      return html;
    }

    function choose(id) {
      if (!ctl) return;
      ctl.scrollToBlock(id);
      activeId = id;
      // 좁은 화면에서 확장 목차는 화면을 덮으므로 고르면 미니로 접는다
      if (expanded && window.matchMedia && window.matchMedia('(max-width: 620px)').matches) {
        expanded = false;
        store.set(KEY_EXP, false);
      }
      render();
    }

    /** 스크롤 위치에 맞춰 지금 보고 있는 구성요소 칩을 강조 */
    function syncActive() {
      if (!ctl || !items.length) return;
      const cr = ctl.container.getBoundingClientRect();
      let cur = null;
      for (const b of items) {
        const el = ctl.blockEl(b.id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.bottom - cr.top > 24) { cur = b; break; }
      }
      const id = cur ? cur.id : null;
      // 미니 모드에서 선지는 '선지' 칩 하나뿐이므로 첫 선지 id로 맞춘다
      let chipId = id;
      if (cur && cur.kind === 'choice') { const fc = items.find((b) => b.kind === 'choice'); chipId = fc ? fc.id : id; }
      activeId = chipId;
      panel.querySelectorAll('[data-id]').forEach((n) => n.classList.toggle('active', n.dataset.id === chipId || n.dataset.id === id));
    }

    function onScroll() {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; syncActive(); });
    }

    function setEnabled(v) {
      on = v;
      store.set(KEY_ON, v);
      render();
    }

    if (toggleBtn) toggleBtn.addEventListener('click', () => setEnabled(!on));

    return {
      /** 새 문제(뷰어 컨트롤러)가 그려졌을 때 호출. null이면 목차를 숨긴다. */
      setController(c) {
        if (scrollBound) { scrollBound.removeEventListener('scroll', onScroll); scrollBound.classList.remove('ctocGutter'); scrollBound = null; }
        ctl = c;
        buildItems();
        if (ctl && ctl.container) { scrollBound = ctl.container; scrollBound.addEventListener('scroll', onScroll, { passive: true }); }
        render();
      },
      /** 블록 모드(이미지↔텍스트)가 바뀌어 DOM이 다시 만들어진 뒤 호출 */
      refresh() { render(); },
      setEnabled,
      isEnabled() { return on; },
      destroy() { if (scrollBound) scrollBound.removeEventListener('scroll', onScroll); panel.remove(); },
    };
  }

  return { create };
})();

window.CompToc = CompToc;
