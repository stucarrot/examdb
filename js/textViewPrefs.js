/* textViewPrefs.js — "텍스트로 보기" 화면(라이브러리 문제 뷰어 + 문제풀이)이
 * 공유하는 글자 크기/테마 설정. 두 화면이 서로 다른 모듈(library.js, solve.js)
 * 안에 있어서 상태를 한 군데(window.TextViewPrefs)에 모아두고 양쪽에서 같은
 * 값을 읽고 쓰게 했다 — "설정하면 메모리에 유지"를 문제 뷰어에서 바꾸든
 * 문제풀이에서 바꾸든 동일하게 적용/기억되도록 하기 위함.
 *
 * DB.meta 스토어에 저장하므로 새로고침·재접속 후에도 유지된다("메모리 유지").
 */

const TextViewPrefs = (() => {
  const KEY = 'textViewPrefs';
  const FONT_SIZES = ['sm', 'md', 'lg', 'xl'];
  const FONT_LABELS = { sm: '작게', md: '보통', lg: '크게', xl: '아주 크게' };
  const THEMES = ['light', 'dark', 'sepia'];
  const THEME_LABELS = { light: '라이트', dark: '다크', sepia: '세피아' };

  let prefs = { fontSize: 'md', theme: 'light' };
  let loaded = false;

  async function load() {
    if (loaded) return prefs;
    try {
      const saved = await DB.getMeta(KEY);
      if (saved && typeof saved === 'object') {
        if (FONT_SIZES.includes(saved.fontSize)) prefs.fontSize = saved.fontSize;
        if (THEMES.includes(saved.theme)) prefs.theme = saved.theme;
      }
    } catch (e) { /* 첫 실행 등으로 값이 없으면 기본값 유지 */ }
    loaded = true;
    return prefs;
  }

  function get() { return prefs; }

  async function set(patch) {
    prefs = { ...prefs, ...patch };
    await DB.setMeta(KEY, prefs);
  }

  /** 텍스트 뷰 컨테이너 엘리먼트에 현재 설정에 맞는 클래스를 입힌다(css/styles.css의
   * .tvFont-*, .tvTheme-* 참고). 호출할 때마다 이전 클래스를 지우고 다시 계산하므로
   * 여러 번 불러도 안전하다. */
  function applyTo(elm) {
    if (!elm) return;
    FONT_SIZES.forEach((s) => elm.classList.remove('tvFont-' + s));
    THEMES.forEach((t) => elm.classList.remove('tvTheme-' + t));
    elm.classList.add('tvFont-' + prefs.fontSize);
    elm.classList.add('tvTheme-' + prefs.theme);
  }

  /** 글자크기/테마 버튼 툴바 HTML. 렌더링하는 쪽(library.js/solve.js)이 자기
   * 텍스트 뷰를 다시 그릴 때마다 이 HTML을 같이 그려 넣고 wireControls()로
   * 이벤트를 연결하면 된다(재렌더 시 이전 리스너는 DOM과 함께 자연 소멸). */
  function controlsHtml() {
    const fontBtns = FONT_SIZES.map((s) =>
      `<button type="button" class="tvBtn${prefs.fontSize === s ? ' active' : ''}" data-tv-font="${s}">${FONT_LABELS[s]}</button>`
    ).join('');
    const themeBtns = THEMES.map((t) =>
      `<button type="button" class="tvBtn${prefs.theme === t ? ' active' : ''}" data-tv-theme="${t}">${THEME_LABELS[t]}</button>`
    ).join('');
    return `
      <div class="tvControls">
        <div class="tvControlGroup"><span class="tvControlLabel">글자 크기</span>${fontBtns}</div>
        <div class="tvControlGroup"><span class="tvControlLabel">테마</span>${themeBtns}</div>
      </div>`;
  }

  /** controlsHtml()로 그려진 버튼들에 클릭 이벤트를 붙인다. onChange는 설정이
   * 바뀐 뒤 호출되는 콜백 — 보통 그 화면을 다시 렌더링해서(applyTo 다시 태우기)
   * 즉시 반영하는 데 쓴다. */
  function wireControls(root, onChange) {
    if (!root) return;
    root.querySelectorAll('[data-tv-font]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await set({ fontSize: btn.dataset.tvFont });
        onChange && onChange();
      });
    });
    root.querySelectorAll('[data-tv-theme]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await set({ theme: btn.dataset.tvTheme });
        onChange && onChange();
      });
    });
  }

  return { load, get, set, applyTo, controlsHtml, wireControls };
})();

window.TextViewPrefs = TextViewPrefs;
