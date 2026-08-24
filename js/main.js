/* main.js — 탭 전환 및 전체 초기화 */

const App = (() => {
  function switchTab(name) {
    document.querySelectorAll('.tabBtn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tabPanel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
    if (name === 'settings') { SettingsUI.refreshStats(); SettingsUI.refreshMemoryList(); }
    if (name === 'library') LibraryUI.onShow();
    if (name === 'solve') SolveUI.onShow();
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

    LibraryUI.refresh();
    switchTab('import');
  }

  return { switchTab, init };
})();

window.App = App;
window.addEventListener('DOMContentLoaded', App.init);
