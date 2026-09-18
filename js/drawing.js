/* drawing.js — 문제풀이(Solve) 화면 전용 "그리기" 오버레이.
 *
 * 상단바 토글(✏️)로 켜면 문제 디스플레이 영역(.solveViewerWrap 안쪽, 즉 상/하단바를 뺀
 * 부분) 위에 필기를 할 수 있고, 우측에 반투명 미니 툴바가 뜬다. 이미지 모드(#solveImageArea)
 * 텍스트/마크다운 모드(#solveTextArea .tvReadingArea) 둘 다 같은 방식으로 동작하도록
 * setContext()를 통해 "지금 보이는 스크롤 컨테이너가 어디인지"만 solve.js가 매 render()마다
 * 알려주면 된다 — 이 모듈은 그 컨테이너 하나를 기준으로 캔버스를 재배치/재계산한다.
 *
 * 좌표는 캔버스의 "그 시점 CSS 크기" 대비 0~1 정규화 값으로 저장한다(글자 크기 변경, 창
 * 크기 변경, 이미지 로드 전/후 등으로 컨테이너 크기가 바뀌어도 다시 스케일해서 그릴 수 있게).
 *
 * 저장은 문제 레코드에 직접 얹는다: question.drawing = { image: Stroke[], text: Stroke[] }
 * (DB 스키마 변경 없이 questions 레코드에 필드 하나 추가 — marks.js의 mark 필드와 같은 방식).
 * Stroke = { color, width, points: [{x,y,p}, ...] } (x,y는 0~1 정규화, p는 필압 0~1 또는 없음).
 */
const Drawing = (() => {
  const PREFS_KEY = 'solveDrawPrefs';
  const COLORS = ['#ff3b30', '#0a84ff', '#1c1c1e', '#34c759'];
  const ERASE_RADIUS = 16; // CSS px — 지우개가 스트로크를 "지웠다"고 인정하는 반경

  let wrapEl = null;
  let toggleBtn = null;
  let toolbarEl = null;
  let canvas = null;
  let ctx = null;

  let contentEl = null;   // 지금 캔버스가 붙어있는 실제 스크롤 컨테이너
  let question = null;    // 지금 그리는 대상 문제 객체(solve.js questions[]의 같은 참조)
  let mode = 'image';     // 'image' | 'text'
  let saveFn = null;      // async (question) => void — 변경 시 영속화

  let enabled = false;    // 상단바 토글 on/off
  let tool = 'pen';       // 'pen' | 'eraser'
  let color = COLORS[0];
  let magic = false;      // 매직펜(픽셀 보색 자동) on/off
  let widthPx = 4;
  let pressureOn = true;

  let strokes = [];        // question.drawing[mode]를 직접 참조
  let activePointerId = null;
  let activeStroke = null;
  let magicColorForStroke = null;
  let dpr = Math.max(1, window.devicePixelRatio || 1);

  function el(sel, root = document) { return root.querySelector(sel); }

  // ==================== 초기화 ====================

  function init(wrap, toggleButton) {
    wrapEl = wrap;
    toggleBtn = toggleButton;
    buildCanvas();
    buildToolbar();
    toggleBtn.addEventListener('click', toggle);
    window.addEventListener('resize', () => { if (contentEl) resizeCanvasToContent(); });
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
      }
    } catch (e) { /* 무시 — 기본값으로 진행 */ }
    syncToolbarState();
  }

  function savePrefs() {
    DB.setMeta(PREFS_KEY, { color, magic, widthPx, pressureOn });
  }

  function buildCanvas() {
    canvas = document.createElement('canvas');
    canvas.className = 'drawCanvas';
    ctx = canvas.getContext('2d');
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerUp);
  }

  function buildToolbar() {
    toolbarEl = document.createElement('div');
    toolbarEl.className = 'drawToolbar hidden';
    toolbarEl.innerHTML = `
      <button type="button" class="drawTBtn" data-act="scrollUp" title="위로 스크롤 (그리기 중엔 스와이프 대신 이 버튼으로)">▲</button>
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
      <button type="button" class="drawTBtn" data-act="scrollDown" title="아래로 스크롤 (그리기 중엔 스와이프 대신 이 버튼으로)">▼</button>
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
    if (act === 'scrollUp') { scrollByPage(-1); return; }
    if (act === 'scrollDown') { scrollByPage(1); return; }
    if (act === 'pressure') { pressureOn = !pressureOn; savePrefs(); syncToolbarState(); return; }
    if (act === 'magic') { magic = !magic; tool = 'pen'; savePrefs(); syncToolbarState(); return; }
    if (act === 'eraser') { tool = tool === 'eraser' ? 'pen' : 'eraser'; syncToolbarState(); return; }
    if (act === 'clear') { onClearClick(); return; }
  }

  function scrollByPage(dir) {
    if (!contentEl) return;
    contentEl.scrollBy({ top: dir * Math.max(120, contentEl.clientHeight * 0.7), behavior: 'smooth' });
  }

  function onClearClick() {
    if (!strokes.length) return;
    if (!confirm('이 문제에 그린 필기를 모두 지울까요?')) return;
    strokes.length = 0;
    persist();
    redrawAll();
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
  }
  function elAll(sel, root) { return Array.from(root.querySelectorAll(sel)); }

  // ==================== on/off ====================

  function toggle() { setEnabled(!enabled); }

  function setEnabled(v) {
    enabled = v;
    toggleBtn.classList.toggle('active', enabled);
    toggleBtn.title = enabled ? '그리기 끄기' : '그리기 켜기 (문제 위에 필기)';
    toolbarEl.classList.toggle('hidden', !enabled);
    canvas.classList.toggle('drawCanvas-active', enabled);
    canvas.style.pointerEvents = enabled ? 'auto' : 'none';
    canvas.style.touchAction = enabled ? 'none' : 'auto'; // 켜져 있을 때만 터치 드래그를 스크롤 대신 그리기로 사용
  }

  function isEnabled() { return enabled; }

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
    if (!newContentEl || !q) { contentEl = null; return; }
    contentEl = newContentEl;
    mode = newMode;
    question = q;
    saveFn = save;
    if (!question.drawing) question.drawing = {};
    if (!Array.isArray(question.drawing[mode])) question.drawing[mode] = [];
    strokes = question.drawing[mode];
    if (getComputedStyle(contentEl).position === 'static') contentEl.style.position = 'relative';
    if (canvas.parentElement !== contentEl) contentEl.appendChild(canvas);
    resizeCanvasToContent();
    // 이미지가 아직 로딩 중이면(높이를 모름) 로드 완료 후 다시 한번 맞춘다.
    Array.from(contentEl.querySelectorAll('img')).forEach((img) => {
      if (!img.complete) img.addEventListener('load', () => { if (contentEl) resizeCanvasToContent(); }, { once: true });
    });
    canvas.style.pointerEvents = enabled ? 'auto' : 'none';
    canvas.style.touchAction = enabled ? 'none' : 'auto';
  }

  function resizeCanvasToContent() {
    if (!contentEl) return;
    const cssW = Math.max(contentEl.scrollWidth, contentEl.clientWidth, 1);
    const cssH = Math.max(contentEl.scrollHeight, contentEl.clientHeight, 1);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redrawAll();
  }

  // ==================== 그리기 ====================

  function pointFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    // rect는 CSS px 기준 — canvas.style.width/height와 같은 좌표계이므로 그대로 나눠 정규화한다.
    const cssW = parseFloat(canvas.style.width) || rect.width || 1;
    const cssH = parseFloat(canvas.style.height) || rect.height || 1;
    const x = (e.clientX - rect.left) / cssW;
    const y = (e.clientY - rect.top) / cssH;
    const p = (pressureOn && e.pressure && e.pressure > 0 && e.pointerType !== 'mouse') ? e.pressure : 1;
    return { x, y, p };
  }

  function toCanvasPx(pt) {
    const cssW = parseFloat(canvas.style.width) || 1;
    const cssH = parseFloat(canvas.style.height) || 1;
    return { x: pt.x * cssW, y: pt.y * cssH };
  }

  function onPointerDown(e) {
    if (!enabled || !contentEl) return;
    activePointerId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    const pt = pointFromEvent(e);
    if (tool === 'eraser') {
      eraseNear(pt);
      return;
    }
    magicColorForStroke = magic ? sampleMagicColor(e.clientX, e.clientY) : null;
    activeStroke = {
      color: magic ? magicColorForStroke : color,
      width: widthPx,
      points: [pt],
    };
    strokes.push(activeStroke);
    redrawAll();
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!enabled || e.pointerId !== activePointerId) return;
    const pt = pointFromEvent(e);
    if (tool === 'eraser') { eraseNear(pt); return; }
    if (!activeStroke) return;
    activeStroke.points.push(pt);
    redrawAll();
    e.preventDefault();
  }

  function onPointerUp(e) {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
    if (activeStroke) {
      if (activeStroke.points.length < 2) {
        // 탭 한 번(점 하나)도 작은 점으로는 남기되, 실수로 찍힌 0.x px 흔적을 막기 위해
        // 점을 살짝 복제해 최소한의 선분을 만든다(길이 0인 stroke는 렌더링에서 안 보임).
        activeStroke.points.push({ ...activeStroke.points[0] });
      }
      activeStroke = null;
      persist();
    }
  }

  function eraseNear(pt) {
    const before = strokes.length;
    const px = toCanvasPx(pt);
    for (let i = strokes.length - 1; i >= 0; i--) {
      if (strokeNearPoint(strokes[i], px)) strokes.splice(i, 1);
    }
    if (strokes.length !== before) { redrawAll(); persist(); }
  }

  function strokeNearPoint(stroke, px) {
    const pts = stroke.points;
    if (pts.length === 1) {
      const a = toCanvasPx(pts[0]);
      return dist(a, px) <= ERASE_RADIUS;
    }
    for (let i = 1; i < pts.length; i++) {
      const a = toCanvasPx(pts[i - 1]);
      const b = toCanvasPx(pts[i]);
      if (distToSegment(px, a, b) <= ERASE_RADIUS) return true;
    }
    return false;
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function distToSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return dist(p, a);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
  }

  function persist() {
    if (!question || !saveFn) return;
    saveFn(question).catch((err) => console.error('필기 저장 실패:', err));
  }

  function redrawAll() {
    if (!ctx) return;
    const cssW = parseFloat(canvas.style.width) || 0;
    const cssH = parseFloat(canvas.style.height) || 0;
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokes.forEach(drawStroke);
  }

  function drawStroke(stroke) {
    const pts = stroke.points;
    if (!pts || pts.length < 2) {
      if (pts && pts.length === 1) {
        const a = toCanvasPx(pts[0]);
        ctx.beginPath();
        ctx.fillStyle = stroke.color;
        ctx.arc(a.x, a.y, stroke.width / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    ctx.strokeStyle = stroke.color;
    for (let i = 1; i < pts.length; i++) {
      const a = toCanvasPx(pts[i - 1]);
      const b = toCanvasPx(pts[i]);
      const p = ((pts[i - 1].p || 1) + (pts[i].p || 1)) / 2;
      ctx.lineWidth = Math.max(1, stroke.width * Math.max(0.25, Math.min(1.4, p)));
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
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

  return { init, setEnabled, isEnabled, setContext };
})();

window.Drawing = Drawing;
