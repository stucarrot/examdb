/* marks.js — 문제 "마크"(이모지 프리셋) 설정.
 *
 * 태그(tags, 자유 텍스트·여러 개 가능)와는 완전히 별개의 기능이다. 문제 하나당
 * "구석에 작게 붙이는" 표시를 미리 정해둔 이모지 프리셋 중 하나만 골라서 붙인다
 * (동시에 여러 개는 못 붙임 — 프리셋 여러 개가 필요하면 PRESETS 배열에 추가하고
 * question.mark는 여전히 문자열 하나만 들고 있으면 됨. 다중 마크가 필요해지면
 * question.marks:[] 배열로 바꾸고 badgeHtml이 여러 개를 나란히 그리도록 확장하면 됨).
 *
 * 저장 형식: question.mark = 프리셋 id 문자열(예: 'review') 또는 ''/undefined(마크 없음).
 * DB 스키마 변경(버전 bump) 없이 그냥 questions 레코드에 필드 하나 얹는 것뿐이다 —
 * 기존 문제들은 mark 필드가 아예 없을 텐데, 없으면 "마크 없음"으로 자연스럽게 취급된다.
 *
 * 프리셋을 추가/변경하고 싶으면 아래 PRESETS 배열만 고치면 된다 — 라이브러리 뷰어,
 * 목록 카드(list/card), 문제풀이 모드, 상세 편집 사이드바의 선택 버튼까지 전부
 * 이 배열 하나를 기준으로 그려지므로 다른 파일을 따로 손댈 필요는 없다.
 */
const Marks = (() => {
  const PRESETS = [
    { id: 'question', emoji: '❓', label: '질문 있음' },
    { id: 'review', emoji: '🔁', label: '다시보기' },
    { id: 'caution', emoji: '⚠️', label: '주의' },
  ];

  function byId(id) {
    return PRESETS.find((p) => p.id === id) || null;
  }

  /**
   * 구석에 작게 붙일 배지 HTML 문자열. markId가 없거나 프리셋에 없는 값이면 빈 문자열
   * (호출 쪽에서 그대로 innerHTML에 넣거나, 빈 문자열이면 hidden 처리하면 됨).
   * extraClass로 위치/크기 변형 클래스(markBadge-tr, markBadge-viewer 등)를 덧붙인다.
   */
  function badgeHtml(markId, extraClass = '') {
    const m = markId && byId(markId);
    if (!m) return '';
    return `<span class="markBadge ${extraClass}" title="${escapeHtml(m.label)}">${m.emoji}</span>`;
  }

  /**
   * 상세 편집 사이드바에 넣을 선택 버튼 묶음 HTML. "없음" 버튼 하나 + 프리셋별 버튼.
   * 클릭 처리는 호출 쪽에서 이벤트 위임(.markPickBtn, data-mark)으로 한다 — 이 모듈은
   * 마크업만 생성하고 상태(DB 저장 등)는 모른다.
   */
  function pickerHtml(currentId) {
    const noneBtn = `<button type="button" class="markPickBtn ${!currentId ? 'active' : ''}" data-mark="" title="마크 없음">–</button>`;
    const presetBtns = PRESETS.map(
      (p) => `<button type="button" class="markPickBtn ${currentId === p.id ? 'active' : ''}" data-mark="${p.id}" title="${escapeHtml(p.label)}">${p.emoji}</button>`
    ).join('');
    return noneBtn + presetBtns;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  return { PRESETS, byId, badgeHtml, pickerHtml };
})();

window.Marks = Marks;
