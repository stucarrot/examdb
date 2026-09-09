/* markdownRender.js — 해설(마크다운 + 수식) 렌더링 공용 헬퍼.
 *
 * 해설 입력란(라이브러리 상세, 선지 보기, 문제풀이 해설 팝업)이 전부 이 모듈 하나로
 * "마크다운 텍스트 → 안전하게 정제된 HTML(+수식 렌더링 완료)"를 만든다. CDN에서 불러온
 * marked(마크다운→HTML), DOMPurify(XSS 방지 정제), KaTeX+auto-render(수식 렌더링)를
 * 감싸는 얇은 래퍼일 뿐이라 로직은 짧다.
 *
 * 수식 구분자는 일부러 \( \)(인라인)과 $$ $$(블록)만 지원하고 홑따옴표 $...$는 지원하지
 * 않는다 — 이 앱의 문제들(자료해석 등)엔 "100달러"류 화폐 표기가 흔한데, 홑 $ 를 수식
 * 구분자로 켜두면 그런 문장에서 뒷부분이 통째로 수식으로 오인식되는 사고가 잦기 때문.
 * (aiExplain.js의 프롬프트도 이 규칙에 맞춰 모델에게 \( \)/$$ $$ 만 쓰라고 지시해둔다.)
 *
 * CDN 스크립트가 아직 로드 전이거나(느린 네트워크) 차단된 경우를 대비해 marked/DOMPurify/
 * KaTeX 중 어느 게 없어도 최대한 안전하게 대체 동작(escape+줄바꿈만 살림)하도록 짰다.
 */

const MarkdownRender = (() => {
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const KATEX_DELIMITERS = [
    { left: '$$', right: '$$', display: true },
    { left: '\\[', right: '\\]', display: true },
    { left: '\\(', right: '\\)', display: false },
  ];

  /** raw(마크다운+LaTeX 원문 텍스트)를 container 안에 렌더링한다. */
  function renderInto(container, raw) {
    if (!container) return;
    const text = String(raw ?? '');
    let html;
    if (window.marked) {
      try { html = marked.parse(text, { breaks: true }); }
      catch (e) { html = `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`; }
    } else {
      html = `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
    }
    container.innerHTML = window.DOMPurify
      ? DOMPurify.sanitize(html, { ADD_ATTR: ['class'] })
      : html;

    if (window.renderMathInElement) {
      try {
        renderMathInElement(container, { delimiters: KATEX_DELIMITERS, throwOnError: false });
      } catch (e) { /* 수식 렌더링 실패는 무시하고 텍스트라도 보여준다 */ }
    }
  }

  /** 빈 문자열이면 placeholder(기본: 안내 문구)를, 아니면 렌더링 결과를 보여준다. */
  function renderIntoOrPlaceholder(container, raw, placeholder = '아직 해설이 없습니다.') {
    if (!container) return;
    if (!String(raw ?? '').trim()) {
      container.innerHTML = `<p class="markdownEmptyHint">${escapeHtml(placeholder)}</p>`;
      return;
    }
    renderInto(container, raw);
  }

  return { renderInto, renderIntoOrPlaceholder };
})();

window.MarkdownRender = MarkdownRender;
