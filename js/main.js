/* main.js — 탭 전환 및 전체 초기화 */

const App = (() => {
  function switchTab(name) {
    document.querySelectorAll('.tabBtn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tabPanel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
    if (name === 'settings') { SettingsUI.refreshStats(); SettingsUI.refreshMemoryList(); }
    if (name === 'library') LibraryUI.onShow();
    if (name === 'solve') SolveUI.onShow();
  }

  /** 문제풀이 화면의 "📝 직접입력" 버튼 등에서 새 브라우저 탭으로 `?qid=<문제id>`를 붙여
   * 이 앱을 다시 열었을 때, 그 쿼리스트링을 보고 라이브러리 탭으로 전환한 뒤 해당 문제의
   * 상세 뷰어를 자동으로 열어준다. 쿼리가 없으면(평소처럼 그냥 열었을 때) 아무 영향 없음 —
   * 기존 "가져오기" 탭으로 시작하는 흐름 그대로 유지.
   * &focus=explanation이 함께 붙어있으면(solve.js의 "해설 직접입력" 전용) 문제 뷰어만 딱
   * 띄우는 데서 그치지 않고, "문제정보" 패널까지 펴서 해설 입력칸 끝에 커서를 놔준다. */
  async function openDeepLinkIfAny() {
    const params = new URLSearchParams(location.search);
    const qid = params.get('qid');
    if (!qid) return false;
    switchTab('library');
    await LibraryUI.openDetail(qid);
    if (params.get('focus') === 'explanation') LibraryUI.focusExplanationField();
    return true;
  }

  async function init() {
    document.querySelectorAll('.tabBtn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    ImportUI.init();
    LibraryUI.init();
    ChoicesUI.init();
    AnswerSheetImport.init();
    SolveUI.init();
    ExportPDF.init();
    SettingsUI.init();
    await TextViewPrefs.load(); // 텍스트 뷰 글자크기/테마 설정을 미리 읽어둬야 첫 렌더부터 바로 반영됨

    await LibraryUI.refresh();
    const openedDeepLink = await openDeepLinkIfAny();
    if (!openedDeepLink) switchTab('import');
  }

  return { switchTab, init };
})();

window.App = App;
window.addEventListener('DOMContentLoaded', App.init);
