/* nativePen.js — Boox(Onyx) 네이티브 펜 연동 (Capacitor APK 전용, 선택 기능)
 *
 * 하는 일: 그리기 모드가 켜져 있고 펜 도구일 때, 필기 영역을 Onyx Pen SDK(TouchHelper)의 "raw drawing"에
 * 넘긴다. SDK가 e-ink 화면에 직접 빠르게 잉크를 그려주고(WebView 캔버스보다 훨씬 빠름), 획이 끝나면
 * 좌표를 이 스크립트로 넘겨준다 → Drawing.addExternalStroke()로 기존 필기 데이터(저장/지우개/표시)에
 * 그대로 합친다.
 *
 * 안전장치: APK에 OnyxPen 플러그인이 없거나 Boox 기기가 아니면 아무 것도 하지 않는다(웹/PC/폰은 기존 방식).
 * 끄고 싶으면 개발자도구/URL에서 localStorage.nativePenOff='1'.
 *
 * 좌표: 플러그인은 WebView 기준 "기기 픽셀"로 주고받는다 → CSS px = 기기 px / devicePixelRatio.
 */
const NativePen = (() => {
  let plugin = null;
  let running = false;
  let lastKey = '';
  let timer = 0;

  function getPlugin() {
    const C = window.Capacitor;
    if (!C || !C.isNativePlatform || !C.isNativePlatform()) return null;
    if (C.getPlatform && C.getPlatform() !== 'android') return null;
    try { return C.registerPlugin ? C.registerPlugin('OnyxPen') : (C.Plugins && C.Plugins.OnyxPen) || null; } catch (e) { return null; }
  }

  const dpr = () => window.devicePixelRatio || 1;
  const toRect = (r, d) => ({ left: Math.round(r.left * d), top: Math.round(r.top * d), right: Math.round(r.right * d), bottom: Math.round(r.bottom * d) });

  /** 필기 영역(limit)과, 그 안에서 펜 입력을 가로채면 안 되는 영역(exclude: 그리기 툴바 등) */
  function buildConfig() {
    const area = Drawing.getDrawRect();
    if (!area) return null;
    const d = dpr();
    const exclude = [];
    document.querySelectorAll('.drawToolbar:not(.hidden), .ctoc:not(.hidden)').forEach((t) => { // 그리기 툴바와 플로팅 목차 위에서는 펜 입력을 가로채지 않는다
      const r = t.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) exclude.push(toRect(r, d));
    });
    const st = Drawing.getPenStyle();
    return { limit: toRect(area, d), exclude, width: Math.max(1, st.width * d) };
  }

  async function sync() {
    if (!plugin) return;
    const st = Drawing.getPenStyle();
    const want = Drawing.isEnabled() && st.tool === 'pen' && !document.hidden;
    if (!want) {
      if (running) { running = false; lastKey = ''; try { await plugin.stop(); } catch (e) { /* 무시 */ } }
      return;
    }
    const cfg = buildConfig();
    if (!cfg) return;
    const key = JSON.stringify(cfg);
    if (running && key === lastKey) return;
    try {
      if (!running) await plugin.start(cfg); else await plugin.update(cfg);
      running = true;
      lastKey = key;
    } catch (e) {
      console.warn('네이티브 펜 시작 실패(기존 방식으로 계속):', e);
      running = false;
    }
  }

  function onStroke(ev) {
    const d = dpr();
    const pts = (ev.points || []).map((p) => ({ x: p.x / d, y: p.y / d, p: p.p }));
    if (pts.length) Drawing.addExternalStroke(pts);
  }

  function onErase(ev) {
    const d = dpr();
    (ev.points || []).forEach((p) => Drawing.eraseAtClient(p.x / d, p.y / d));
  }

  async function init() {
    if (localStorage.getItem('nativePenOff') === '1') return;
    plugin = getPlugin();
    if (!plugin) return;
    try {
      const r = await plugin.isAvailable();
      if (!r || !r.available) { plugin = null; return; }
    } catch (e) { plugin = null; return; }
    plugin.addListener('stroke', onStroke);
    plugin.addListener('erase', onErase);
    Drawing.onEnabledChange(sync);
    Drawing.onStyleChange(sync);
    window.addEventListener('resize', sync);
    document.addEventListener('visibilitychange', sync);
    // 문제 전환·화면 재렌더 등으로 필기 영역/툴바 위치가 바뀌는 경우를 가볍게 따라간다
    timer = setInterval(() => { if (Drawing.isEnabled()) sync(); }, 700);
    console.info('Boox 네이티브 펜 사용 가능 — 필기를 SDK로 처리합니다.');
  }

  return { init };
})();

window.NativePen = NativePen;
document.addEventListener('DOMContentLoaded', () => setTimeout(() => NativePen.init(), 0));
