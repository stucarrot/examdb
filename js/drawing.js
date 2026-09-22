/* drawing.js — 문제풀이(Solve) 화면 전용 "그리기" 오버레이.
 *
 * 상단바 토글(✏️)로 켜면 문제 디스플레이 영역(.solveViewerWrap 안쪽, 즉 상/하단바를 뺀
 * 부분) 위에 필기를 할 수 있고, 우측에 반투명 미니 툴바가 뜬다. 이미지 모드(#solveImageArea)
 * 텍스트/마크다운 모드(#solveTextArea .tvReadingArea) 둘 다 같은 방식으로 동작하도록
 * setContext()를 통해 "지금 보이는 스크롤 컨테이너가 어디인지"만 solve.js가 매 render()마다
 * 알려주면 된다 — 이 모듈은 그 컨테이너 하나를 기준으로 캔버스를 재배치/재계산한다.
 *
 * 좌표는 컨테이너의 "스크롤 전체 크기(scrollWidth/Height)" 대비 0~1 정규화 값으로 저장한다(글자
 * 크기 변경, 창 크기 변경, 이미지 로드 전/후 등으로 컨테이너 크기가 바뀌어도 다시 스케일해서
 * 그릴 수 있게).
 *
 * [성능 — e-ink(Boox 등) 대응, v2]
 *  - 캔버스는 이제 스크롤 컨테이너 안이 아니라 .solveViewerWrap 위에 "보이는 영역 크기"로만
 *    올라간다(예전엔 스크롤 전체 높이×dpr 크기의 거대한 캔버스가 컨테이너 안에 있었음 → 긴
 *    문제에서 소프트웨어 렌더링으로 떨어지고 갱신 비용이 컸다). 스크롤하면 보이는 영역의
 *    스트로크만 다시 그린다(rAF로 묶어서).
 *  - 펜이 움직일 때는 전체를 지우고 다시 그리지 않고, 새로 생긴 선분만 캔버스에 덧그린다
 *    (필기가 많아져도 입력당 비용이 일정). getCoalescedEvents()로 묶여 온 중간 점도 모두 반영.
 *  - 캔버스 컨텍스트에 desynchronized 힌트를 줘서 입력→화면 지연을 줄인다.
 *  - 저장(DB.updateQuestion)은 획이 끝날 때마다 바로 하지 않고 잠깐(0.6초) 모았다가 한 번에,
 *    문제를 넘기거나 앱이 백그라운드로 갈 때는 즉시 저장한다.
 *
 * 저장은 문제 레코드에 직접 얹는다: question.drawing = { image: Stroke[], text: Stroke[] }
 * (DB 스키마 변경 없이 questions 레코드에 필드 하나 추가 — marks.js의 mark 필드와 같은 방식).
 * Stroke = { color, width, points: [{x,y,p}, ...] } (x,y는 0~1 정규화, p는 필압 0~1 또는 없음).
 *
 * 필기는 그리기 모드(✏️)가 켜져 있을 때, 그리고 "그리기 꺼짐 시에도 표시" 설정이 꺼져
 * 있을 때만 그리기 모드 여부에 따라 숨겨진다 — hideWhenOff는 사용자가 보기설정 패널에서
 * 고를 수 있는 선호값이다(기본값 true, 즉 꺼지면 숨김). setHideWhenOff()/getHideWhenOff()
 * 참고. 데이터 자체는 지워지지 않으니 표시 설정을 바꿔도 필기는 그대로 유지된다.
 * 또한 이 필기는 "문제풀기 세션" 하나에 한정된 스크래치로 취급한다 — solve.js가 새
 * 세션을 시작할 때(createSession 이후 questions 배열이 채워지는 시점) 그 세션에 들어갈
 * 문제들의 남아있던 drawing 필드를 모두 지운다(resetSessionDrawings 참고). 즉 같은
 * 세션 안에서 나갔다 이어서 풀면 필기가 그대로 남지만, 그 세션이 끝나고 새 세션을
 * 시작하면 필기는 초기화된다.
 */
const Drawing = (() => {
  const PREFS_KEY = 'solveDrawPrefs';
  const COLORS = ['#ff3b30', '#0a84ff', '#1c1c1e', '#34c759'];
  const ERASE_RADIUS = 16; // CSS px — 지우개가 스트로크를 "지웠다"고 인정하는 반경
  const MIN_POINT_DIST = 0.7; // CSS px — 이보다 가까운 점은 버린다(점 수·재그리기 비용 절감)
  const PERSIST_DELAY = 600; // ms

  let wrapEl = null;
  let toggleBtn = null;
  let toolbarEl = null;
  let canvas = null;
  let ctx = null;

  let contentEl = null;   // 지금 필기가 얹힌 실제 스크롤 컨테이너
  let question = null;    // 지금 그리는 대상 문제 객체(solve.js questions[]의 같은 참조)
  let mode = 'image';     // 'image' | 'text'
  let saveFn = null;      // async (question) => void — 변경 시 영속화

  let enabled = false;    // 상단바 토글 on/off
  let minimized = false;  // 우측 미니 툴바를 구석으로 축소해둔 상태(그리기는 계속 가능, 버튼만 숨김)
  let hideWhenOff = true; // 그리기 꺼짐 상태일 때 이미 그린 필기까지 숨길지(true=숨김, false=계속 표시)
  let tool = 'pen';       // 'pen' | 'eraser'
  let color = COLORS[0];
  let magic = false;      // 매직펜(픽셀 보색 자동) on/off
  let widthPx = 4;
  let pressureOn = true;

  let strokes = [];        // question.drawing[mode]를 직접 참조
  let activePointerId = null;
  let activeStroke = null;
  let activeLast = null;   // 진행 중인 획의 마지막 점(뷰 좌표)
  let magicColorForStroke = null;
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));

  // ---- 기하 캐시 (매 이벤트마다 레이아웃을 읽지 않도록) ----
  let contentW = 1, contentH = 1; // 컨테이너의 scrollWidth/scrollHeight (CSS px) — 정규화 기준
  let viewW = 1, viewH = 1;       // 캔버스 CSS 크기 = 컨테이너의 보이는 영역
  let canvasRect = null;          // 획을 시작할 때 갱신하는 캔버스의 화면상 위치
  let scrollBound = null;         // scroll 리스너를 걸어둔 컨테이너
  let resizeObs = null;
  let rafId = 0;
  const bboxCache = new WeakMap(); // stroke → {minX,minY,maxX,maxY} (정규화 좌표). 저장 데이터를 오염시키지 않으려고 WeakMap 사용

  let persistTimer = null;
  let persistDirtyQ = null;

  function el(sel, root = document) { return root.querySelector(sel); }

  // ==================== 초기화 ====================

  function init(wrap, toggleButton) {
    wrapEl = wrap;
    toggleBtn = toggleButton;
    buildCanvas();
    buildToolbar();
    toggleBtn.addEventListener('click', toggle);
    window.addEventListener('resize', onLayoutChange);
    window.addEventListener('orientationchange', onLayoutChange);
    // 앱이 백그라운드로 가거나 닫히기 직전에 모아둔 저장을 확실히 내보낸다.
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushPersist(); });
    window.addEventListener('pagehide', flushPersist);
    if (window.ResizeObserver) resizeObs = new ResizeObserver(onLayoutChange);
    loadPrefs();
  }

  async function loadPrefs() {
    try {
      const p = await DB.getMeta(PREFS_KEY);
      if (p) {
        if (p.color) color = p.color;
        if (typeof p.magic === 'boolean') magic = p.magic;
        if (p.widthPx) widthPx = p.widthPx;
        if (typeof p.pressureOn === 'boolean') pressureOn = p.pressureOn;
        if (typeof p.hideWhenOff === 'boolean') hideWhenOff = p.hideWhenOff;
      }
    } catch (e) { /* 무시 — 기본값으로 진행 */ }
    syncToolbarState();
  }

  function savePrefs() {
    DB.setMeta(PREFS_KEY, { color, magic, widthPx, pressureOn, hideWhenOff });
  }

  function buildCanvas() {
    canvas = document.createElement('canvas');
    canvas.className = 'drawCanvas hidden';
    // desynchronized: 캔버스 갱신을 DOM 합성과 분리해 입력→화면 지연을 줄인다(Chromium 계열).
    ctx = canvas.getContext('2d', { desynchronized: true }) || canvas.getContext('2d');
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    // 캔버스가 컨테이너 밖(형제)에 있으므로, 그리기 모드에서 마우스 휠은 컨테이너로 넘겨준다.
    canvas.addEventListener('wheel', (e) => {
      if (!contentEl) return;
      contentEl.scrollBy(e.deltaX, e.deltaY);
      e.preventDefault();
    }, { passive: false });
    wrapEl.appendChild(canvas);
  }

  function buildToolbar() {
    toolbarEl = document.createElement('div');
    toolbarEl.className = 'drawToolbar hidden';
    toolbarEl.innerHTML = `
      <button type="button" class="drawTBtn" data-act="minimize" title="그리기 바 최소화">⤡</button>
      <div class="drawTSep"></div>
      <div class="drawThicknessWrap" title="굵기 조절">
        <input type="range" class="drawThicknessRange" min="1" max="24" step="1" value="${widthPx}">
        <span class="drawThicknessDot"></span>
      </div>
      <button type="button" class="drawTBtn" data-act="pressure" title="필압 감지 켜기/끄기 (펜/스타일러스)">✒️</button>
      <div class="drawTSep"></div>
      <div class="drawColorGrid">
        ${COLORS.map((c) => `<button type="button" class="drawColorSwatch" data-color="${c}" style="background:${c}" title="펜 색"></button>`).join('')}
      </div>
      <button type="button" class="drawTBtn" data-act="magic" title="매직펜 — 배경 픽셀색의 보색을 자동으로 골라줍니다">🪄</button>
      <input type="color" class="drawColorCustom" title="직접 색상 선택" value="${color}">
      <div class="drawTSep"></div>
      <button type="button" class="drawTBtn" data-act="eraser" title="지우개 (선 단위로 지웁니다)">🧽</button>
      <button type="button" class="drawTBtn" data-act="clear" title="이 문제의 필기 모두 지우기">🗑️</button>
      <div class="drawTSep"></div>
      <button type="button" class="drawTBtn drawKeepMin" data-act="scrollUp" title="위로 스크롤 (그리기 중엔 스와이프 대신 이 버튼으로)">▲</button>
      <button type="button" class="drawTBtn drawKeepMin" data-act="restore" title="그리기 바 원래대로">⤢</button>
      <button type="button" class="drawTBtn drawKeepMin" data-act="scrollDown" title="아래로 스크롤 (그리기 중엔 스와이프 대신 이 버튼으로)">▼</button>
    `;
    wrapEl.appendChild(toolbarEl);
    toolbarEl.addEventListener('click', onToolbarClick);
    el('.drawThicknessRange', toolbarEl).addEventListener('input', (e) => {
      widthPx = Number(e.target.value) || 4;
      savePrefs();
      syncToolbarState();
    });
    el('.drawColorCustom', toolbarEl).addEventListener('input', (e) => {
      color = e.target.value;
      magic = false;
      savePrefs();
      syncToolbarState();
    });
  }

  function onToolbarClick(e) {
    const swatch = e.target.closest('.drawColorSwatch');
    if (swatch) {
      color = swatch.dataset.color;
      magic = false;
      tool = 'pen';
      savePrefs();
      syncToolbarState();
      return;
    }
    const btn = e.target.closest('.drawTBtn');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'minimize') { setMinimized(true); return; }
    if (act === 'restore') { setMinimized(false); return; }
    if (act === 'scrollUp') { scrollByPage(-1); return; }
    if (act === 'scrollDown') { scrollByPage(1); return; }
    if (act === 'pressure') { pressureOn = !pressureOn; savePrefs(); syncToolbarState(); return; }
    if (act === 'magic') { magic = !magic; tool = 'pen'; savePrefs(); syncToolbarState(); return; }
    if (act === 'eraser') { tool = tool === 'eraser' ? 'pen' : 'eraser'; syncToolbarState(); return; }
    if (act === 'clear') { onClearClick(); return; }
  }

  /** 우측 미니 툴바를 문제 영역 우측 하단 구석으로 축소한다(펼침 상태의 모든 버튼을
   * 숨기고 위로 스크롤/원래대로/아래로 스크롤 3개만 작게 남긴다 — css/styles.css의
   * .drawToolbar.minimized, .drawKeepMin 참고). 그리기 자체는 축소 중에도 계속 가능
   * (캔버스 포인터 이벤트는 그대로 유지) — 화면을 가리는 툴바만 잠깐 치워두는 용도. */
  function setMinimized(v) {
    minimized = v;
    toolbarEl.classList.toggle('minimized', minimized);
    notifyStyle();
  }

  function scrollByPage(dir) {
    if (!contentEl) return;
    contentEl.scrollBy({ top: dir * Math.max(120, contentEl.clientHeight * 0.7), behavior: 'auto' });
  }

  function onClearClick() {
    if (!strokes.length) return;
    if (!confirm('이 문제에 그린 필기를 모두 지울까요?')) return;
    strokes.length = 0;
    persistSoon();
    redrawNow();
  }

  function syncToolbarState() {
    if (!toolbarEl) return;
    el('.drawThicknessRange', toolbarEl).value = String(widthPx);
    const dot = el('.drawThicknessDot', toolbarEl);
    const size = Math.max(3, Math.min(22, widthPx));
    dot.style.width = size + 'px';
    dot.style.height = size + 'px';
    dot.style.background = magic ? 'conic-gradient(from 0deg, #ff3b30, #0a84ff, #34c759, #ff3b30)' : color;
    el('[data-act="pressure"]', toolbarEl).classList.toggle('active', pressureOn);
    el('[data-act="magic"]', toolbarEl).classList.toggle('active', magic);
    el('[data-act="eraser"]', toolbarEl).classList.toggle('active', tool === 'eraser');
    elAll('.drawColorSwatch', toolbarEl).forEach((s) => s.classList.toggle('active', !magic && tool === 'pen' && s.dataset.color === color));
    notifyStyle();
  }
  function elAll(sel, root) { return Array.from(root.querySelectorAll(sel)); }

  // ==================== on/off ====================

  function toggle() { setEnabled(!enabled); }

  function setEnabled(v) {
    enabled = v;
    if (enabled) setMinimized(false); // 다시 켤 때마다 항상 펼쳐진 상태로 시작(패널 열림/닫힘과 같은 방식)
    toggleBtn.classList.toggle('active', enabled);
    toggleBtn.title = enabled ? '그리기 끄기' : '그리기 켜기 (문제 위에 필기)';
    toolbarEl.classList.toggle('hidden', !enabled);
    canvas.classList.toggle('drawCanvas-active', enabled);
    updateCanvasVisibility();
    canvas.style.pointerEvents = enabled ? 'auto' : 'none';
    canvas.style.touchAction = enabled ? 'none' : 'auto'; // 켜져 있을 때만 터치 드래그를 스크롤 대신 그리기로 사용
    if (enabled) { onLayoutChange(); }
    if (!enabled) flushPersist();
    for (const fn of enabledListeners) { try { fn(enabled); } catch (e) { /* 무시 */ } }
  }

  /** 캔버스를 지금 상태(그리기 on/off, 꺼짐 시 숨김 여부 선호값)에 맞게 보이거나 숨긴다.
   * hideWhenOff=false면 꺼져 있어도(포인터 이벤트만 비활성화된 채) 필기가 계속 보인다. */
  function updateCanvasVisibility() {
    if (!canvas) return;
    const hidden = (!enabled && hideWhenOff) || !contentEl;
    const was = canvas.classList.contains('hidden');
    canvas.classList.toggle('hidden', hidden);
    if (was && !hidden) requestRedraw();
  }

  function isEnabled() { return enabled; }

  function getHideWhenOff() { return hideWhenOff; }

  /** 보기설정 패널의 "그리기 꺼짐 시 필기" 토글에서 호출 — 즉시 화면에 반영하고 선호값을
   * 저장한다(다음에 문제풀이에 들어와도 이어서 적용). */
  function setHideWhenOff(v) {
    hideWhenOff = v;
    savePrefs();
    updateCanvasVisibility();
  }

  const enabledListeners = [];
  const styleListeners = [];
  /** 펜 도구/색/굵기/툴바 상태가 바뀔 때 알림(네이티브 펜이 제외 영역·스타일을 다시 맞추는 데 사용). */
  function onStyleChange(fn) { styleListeners.push(fn); }
  function notifyStyle() { for (const fn of styleListeners) { try { fn(getPenStyle()); } catch (e) { /* 무시 */ } } }
  /** 그리기 켜짐/꺼짐이 바뀔 때 알림을 받는다(네이티브 펜 플러그인 연동 등에 사용). */
  function onEnabledChange(fn) { enabledListeners.push(fn); }

  // ==================== 컨텍스트 전환(문제/모드 바뀔 때마다 solve.js가 호출) ====================

  /**
   * @param newContentEl 지금 실제로 스크롤되는 컨테이너(이미지 모드는 #solveImageArea,
   *   텍스트 모드는 #solveTextArea 안의 .tvReadingArea). render()가 매번 innerHTML을
   *   새로 그리므로 이 인자도 매번 새 DOM 참조일 수 있다 — 그래서 매 render()마다 다시 불러야 함.
   * @param newMode 'image' | 'text'
   * @param q 지금 문제 객체(questions[] 배열의 참조 그대로)
   * @param save async (q) => void — 변경사항 저장 콜백(보통 DB.updateQuestion)
   */
  function setContext(newContentEl, newMode, q, save) {
    if (!newContentEl || !q) { contentEl = null; unbindContent(); updateCanvasVisibility(); return; }
    // 다른 문제로 넘어가는 순간, 모아둔 저장을 먼저 내보낸다.
    if (persistDirtyQ && persistDirtyQ !== q) flushPersist();
    activeStroke = null; activePointerId = null; activeLast = null;
    contentEl = newContentEl;
    mode = newMode;
    question = q;
    saveFn = save;
    if (!question.drawing) question.drawing = {};
    if (!Array.isArray(question.drawing[mode])) question.drawing[mode] = [];
    strokes = question.drawing[mode];
    bindContent();
    canvas.style.pointerEvents = enabled ? 'auto' : 'none';
    canvas.style.touchAction = enabled ? 'none' : 'auto';
    updateCanvasVisibility();
    onLayoutChange();
    // 이미지가 아직 로딩 중이면(높이를 모름) 로드 완료 후 다시 한번 맞춘다.
    Array.from(contentEl.querySelectorAll('img')).forEach((img) => {
      if (!img.complete) img.addEventListener('load', () => { if (contentEl) onLayoutChange(); }, { once: true });
    });
  }

  function bindContent() {
    unbindContent();
    scrollBound = contentEl;
    scrollBound.addEventListener('scroll', onScroll, { passive: true });
    if (resizeObs) {
      resizeObs.disconnect();
      resizeObs.observe(contentEl);
      Array.from(contentEl.children).forEach((c) => resizeObs.observe(c)); // 안쪽 내용이 커지면 scrollHeight가 바뀜
    }
  }
  function unbindContent() {
    if (scrollBound) scrollBound.removeEventListener('scroll', onScroll);
    scrollBound = null;
    if (resizeObs) resizeObs.disconnect();
  }

  function onScroll() { requestRedraw(); }

  /** 컨테이너 크기/위치가 바뀌었을 때(창 크기, 글자 크기, 이미지 로드 등) 캔버스를 다시 맞추고 그린다. */
  function onLayoutChange() {
    if (!contentEl || !canvas) return;
    if (!contentEl.isConnected) return;
    measure();
    requestRedraw();
  }

  function measure() {
    const w = wrapEl.getBoundingClientRect();
    const c = contentEl.getBoundingClientRect();
    const nw = Math.max(1, Math.round(contentEl.clientWidth));
    const nh = Math.max(1, Math.round(contentEl.clientHeight));
    canvas.style.left = (c.left - w.left + contentEl.clientLeft) + 'px';
    canvas.style.top = (c.top - w.top + contentEl.clientTop) + 'px';
    if (nw !== viewW || nh !== viewH || canvas.width !== Math.round(nw * dpr)) {
      viewW = nw; viewH = nh;
      canvas.style.width = nw + 'px';
      canvas.style.height = nh + 'px';
      canvas.width = Math.round(nw * dpr);
      canvas.height = Math.round(nh * dpr);
    }
    contentW = Math.max(contentEl.scrollWidth, contentEl.clientWidth, 1);
    contentH = Math.max(contentEl.scrollHeight, contentEl.clientHeight, 1);
  }

  // ==================== 좌표 변환 ====================

  // 정규화 좌표 → 보이는 캔버스 좌표(CSS px)
  function toView(pt, sl, st) { return { x: pt.x * contentW - sl, y: pt.y * contentH - st }; }

  // ==================== 그리기 ====================

  function pressureOf(e) {
    return (pressureOn && e.pressure && e.pressure > 0 && e.pointerType !== 'mouse') ? e.pressure : 1;
  }

  function widthFor(stroke, pa, pb) {
    const p = ((pa || 1) + (pb || 1)) / 2;
    return Math.max(1, stroke.width * Math.max(0.25, Math.min(1.4, p)));
  }

  function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

  function onPointerDown(e) {
    if (!enabled || !contentEl) return;
    if (activePointerId !== null) return; // 이미 다른 포인터(예: 손바닥)로 그리는 중이면 무시
    activePointerId = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 합성 이벤트 등 — 무시 */ }
    canvasRect = canvas.getBoundingClientRect();
    measure(); // 획을 시작하는 순간의 컨테이너 크기를 정규화 기준으로 고정
    const v = { x: e.clientX - canvasRect.left, y: e.clientY - canvasRect.top };
    if (tool === 'eraser') {
      eraseAt(v);
      return;
    }
    magicColorForStroke = magic ? sampleMagicColor(e.clientX, e.clientY) : null;
    activeStroke = {
      color: magic ? magicColorForStroke : color,
      width: widthPx,
      points: [{ x: (v.x + contentEl.scrollLeft) / contentW, y: (v.y + contentEl.scrollTop) / contentH, p: pressureOf(e) }],
    };
    strokes.push(activeStroke);
    activeLast = v;
    // 점 하나만 찍어도 보이도록 작은 점을 즉시 그린다.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = activeStroke.color;
    ctx.beginPath();
    ctx.arc(v.x, v.y, activeStroke.width / 2, 0, Math.PI * 2);
    ctx.fill();
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!enabled || e.pointerId !== activePointerId) return;
    const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
    const list = evs.length ? evs : [e];
    if (tool === 'eraser') {
      for (const ev of list) eraseAt({ x: ev.clientX - canvasRect.left, y: ev.clientY - canvasRect.top });
      return;
    }
    if (!activeStroke) return;
    const sl = contentEl.scrollLeft, st = contentEl.scrollTop;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = activeStroke.color;
    const pts = activeStroke.points;
    for (const ev of list) {
      const v = { x: ev.clientX - canvasRect.left, y: ev.clientY - canvasRect.top };
      if (activeLast && Math.hypot(v.x - activeLast.x, v.y - activeLast.y) < MIN_POINT_DIST) continue;
      pts.push({ x: (v.x + sl) / contentW, y: (v.y + st) / contentH, p: pressureOf(ev) });
      // 새로 생긴 조각만 덧그린다: (k-2,k-1의 중점) → (k-1,k의 중점), 제어점 k-1
      drawPiece(activeStroke, pts, pts.length - 1, sl, st);
      activeLast = v;
    }
    e.preventDefault();
  }

  function onPointerUp(e) {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
    if (activeStroke) {
      const pts = activeStroke.points;
      if (pts.length < 2) {
        // 탭 한 번(점 하나)도 작은 점으로 남기되, 길이 0인 획은 다시 그릴 때 안 보이므로 점을 복제한다.
        pts.push({ ...pts[0] });
      } else {
        // 마지막 중점 → 마지막 점까지 이어 붙여 획 끝을 마무리
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.lineCap = 'round';
        ctx.strokeStyle = activeStroke.color;
        drawTail(activeStroke, pts, contentEl.scrollLeft, contentEl.scrollTop);
      }
      bboxCache.delete(activeStroke);
      activeStroke = null;
      activeLast = null;
      persistSoon();
    }
  }

  /** k번째 점(k>=1)까지 도달했을 때 새로 확정되는 곡선 조각을 그린다.
   *  중점 → 중점 이차곡선(제어점=사이 점)이라 점이 듬성듬성해도 꺾이지 않는다. */
  function drawPiece(stroke, pts, k, sl, st) {
    const p1 = toView(pts[k - 1], sl, st);
    const p2 = toView(pts[k], sl, st);
    const a = k === 1 ? p1 : midpoint(toView(pts[k - 2], sl, st), p1);
    const b = midpoint(p1, p2);
    ctx.lineWidth = widthFor(stroke, pts[k - 1].p, pts[k].p);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(p1.x, p1.y, b.x, b.y);
    ctx.stroke();
  }

  /** 획 끝 마무리: 마지막 중점 → 마지막 점 */
  function drawTail(stroke, pts, sl, st) {
    const n = pts.length - 1;
    if (n < 1) return;
    const last = toView(pts[n], sl, st);
    const m = midpoint(toView(pts[n - 1], sl, st), last);
    ctx.lineWidth = widthFor(stroke, pts[n - 1].p, pts[n].p);
    ctx.beginPath();
    ctx.moveTo(m.x, m.y);
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }

  // ==================== 지우개(선 단위) ====================

  function strokeBBox(stroke) {
    let bb = bboxCache.get(stroke);
    if (bb) return bb;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of stroke.points) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    bb = { minX, minY, maxX, maxY };
    bboxCache.set(stroke, bb);
    return bb;
  }

  /** v: 캔버스(보이는 영역) 좌표. 컨텐츠 좌표로 바꿔 스트로크와 거리를 잰다. */
  function eraseAt(v) {
    const cx = v.x + contentEl.scrollLeft;
    const cy = v.y + contentEl.scrollTop;
    const rx = ERASE_RADIUS / contentW, ry = ERASE_RADIUS / contentH;
    let changed = false;
    for (let i = strokes.length - 1; i >= 0; i--) {
      const s = strokes[i];
      const bb = strokeBBox(s);
      const nx = cx / contentW, ny = cy / contentH;
      if (nx < bb.minX - rx || nx > bb.maxX + rx || ny < bb.minY - ry || ny > bb.maxY + ry) continue; // 빠른 배제
      if (strokeNear(s, cx, cy)) { strokes.splice(i, 1); changed = true; }
    }
    if (changed) { requestRedraw(); persistSoon(); }
  }

  function strokeNear(stroke, cx, cy) {
    const pts = stroke.points;
    if (pts.length === 1) {
      return Math.hypot(pts[0].x * contentW - cx, pts[0].y * contentH - cy) <= ERASE_RADIUS;
    }
    let ax = pts[0].x * contentW, ay = pts[0].y * contentH;
    for (let i = 1; i < pts.length; i++) {
      const bx = pts[i].x * contentW, by = pts[i].y * contentH;
      if (distToSegment(cx, cy, ax, ay, bx, by) <= ERASE_RADIUS) return true;
      ax = bx; ay = by;
    }
    return false;
  }

  function distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  // ==================== 저장(모아서) ====================

  function persistSoon() {
    if (!question || !saveFn) return;
    persistDirtyQ = question;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(flushPersist, PERSIST_DELAY);
  }

  function flushPersist() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    const q = persistDirtyQ;
    persistDirtyQ = null;
    if (!q || !saveFn) return;
    try {
      const r = saveFn(q);
      if (r && r.catch) r.catch((err) => console.error('필기 저장 실패:', err));
    } catch (err) { console.error('필기 저장 실패:', err); }
  }

  // ==================== 전체 다시 그리기 (스크롤/리사이즈/지우기 때만) ====================

  function requestRedraw() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; redrawNow(); });
  }

  function redrawNow() {
    if (!ctx || !contentEl) return;
    const sl = contentEl.scrollLeft, st = contentEl.scrollTop;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewW, viewH);
    if (canvas.classList.contains('hidden')) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // 보이는 영역(정규화 좌표로 환산) 밖의 획은 건너뛴다.
    const vx0 = sl / contentW, vx1 = (sl + viewW) / contentW;
    const vy0 = st / contentH, vy1 = (st + viewH) / contentH;
    const padX = 40 / contentW, padY = 40 / contentH;
    for (const s of strokes) {
      const bb = strokeBBox(s);
      if (bb.maxX < vx0 - padX || bb.minX > vx1 + padX || bb.maxY < vy0 - padY || bb.minY > vy1 + padY) continue;
      drawStrokeFull(s, sl, st);
    }
  }

  function drawStrokeFull(stroke, sl, st) {
    const pts = stroke.points;
    if (!pts || !pts.length) return;
    if (pts.length === 1 || (pts.length === 2 && pts[0].x === pts[1].x && pts[0].y === pts[1].y)) {
      const a = toView(pts[0], sl, st);
      ctx.beginPath();
      ctx.fillStyle = stroke.color;
      ctx.arc(a.x, a.y, stroke.width / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.strokeStyle = stroke.color;
    for (let k = 1; k < pts.length; k++) drawPiece(stroke, pts, k, sl, st);
    drawTail(stroke, pts, sl, st);
  }

  // ==================== 매직펜(픽셀 보색 자동) ====================

  /** clientX/clientY 아래에 있는 실제 픽셀색을 읽어 그 보색을 반환한다. <img>였으면 그
   * 이미지의 해당 위치 픽셀을 직접 샘플링하고, 아니면(텍스트 모드 등) 그 지점 요소의
   * 배경색을 대신 샘플링한다 — 둘 다 실패하면 흰 배경 기준 보색(검정)으로 대체. */
  function sampleMagicColor(clientX, clientY) {
    const prevPE = canvas.style.pointerEvents;
    canvas.style.pointerEvents = 'none'; // 캔버스 자신 말고 아래 실제 컨텐츠를 집어야 함
    const target = document.elementFromPoint(clientX, clientY);
    canvas.style.pointerEvents = prevPE;
    let rgb = null;
    if (target && target.tagName === 'IMG') {
      rgb = samplePixelFromImg(target, clientX, clientY);
    }
    if (!rgb) {
      const probe = target || contentEl;
      const bg = probe ? getComputedStyle(probe).backgroundColor : '';
      rgb = parseRgb(bg) || [255, 255, 255];
    }
    return `rgb(${255 - rgb[0]}, ${255 - rgb[1]}, ${255 - rgb[2]})`;
  }

  function samplePixelFromImg(img, clientX, clientY) {
    try {
      const rect = img.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const sx = ((clientX - rect.left) / rect.width) * img.naturalWidth;
      const sy = ((clientY - rect.top) / rect.height) * img.naturalHeight;
      const tmp = document.createElement('canvas');
      tmp.width = 1; tmp.height = 1;
      const tctx = tmp.getContext('2d');
      tctx.drawImage(img, sx, sy, 1, 1, 0, 0, 1, 1);
      const d = tctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    } catch (e) {
      return null; // 캔버스 오염(taint) 등 어떤 이유로든 실패하면 배경색 대체 경로로
    }
  }

  function parseRgb(css) {
    const m = css && css.match(/(\d+(?:\.\d+)?)/g);
    if (!m || m.length < 3) return null;
    return [Number(m[0]), Number(m[1]), Number(m[2])];
  }

  // ==================== 외부(네이티브 펜 등)에서 만든 획 추가 ====================

  /** 화면(client) 좌표의 점 목록으로 만든 획을 지금 문제에 추가한다. 안드로이드 Boox 네이티브
   * 펜(js/nativePen.js)이 원시 필기 입력을 넘겨줄 때 사용 — 저장/다시 그리기는 일반 획과 같다.
   * @param pts [{x,y,p}] clientX/clientY 기준
   * @param opts {color,width} 생략하면 현재 펜 설정 */
  function addExternalStroke(pts, opts = {}) {
    if (!contentEl || !pts || !pts.length) return;
    canvasRect = canvas.getBoundingClientRect();
    measure();
    const sl = contentEl.scrollLeft, st = contentEl.scrollTop;
    const col = opts.color || (magic && pts.length ? sampleMagicColor(pts[0].x, pts[0].y) : color);
    const stroke = {
      color: col,
      width: opts.width || widthPx,
      points: pts.map((p) => ({
        x: (p.x - canvasRect.left + sl) / contentW,
        y: (p.y - canvasRect.top + st) / contentH,
        p: typeof p.p === 'number' ? p.p : 1,
      })),
    };
    if (stroke.points.length === 1) stroke.points.push({ ...stroke.points[0] });
    strokes.push(stroke);
    persistSoon();
    requestRedraw();
  }

  /** 네이티브 펜이 지우개로 지운 위치(client 좌표)를 넘길 때 */
  function eraseAtClient(clientX, clientY) {
    if (!contentEl) return;
    canvasRect = canvas.getBoundingClientRect();
    measure();
    eraseAt({ x: clientX - canvasRect.left, y: clientY - canvasRect.top });
  }

  /** 네이티브 펜 오버레이가 화면 좌표로 그릴 영역(=캔버스가 덮는 컨테이너의 화면 사각형) */
  function getDrawRect() {
    if (!contentEl) return null;
    const r = contentEl.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }

  function getPenStyle() { return { color, width: widthPx, magic, tool, pressureOn }; }

  return { init, setEnabled, isEnabled, setContext, getHideWhenOff, setHideWhenOff,
    onEnabledChange, onStyleChange, addExternalStroke, eraseAtClient, getDrawRect, getPenStyle, requestRedraw };
})();

window.Drawing = Drawing;
