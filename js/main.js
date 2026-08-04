/* main.js — 탭 전환 및 전체 초기화 */

const App = (() => {
  function switchTab(name) {
    document.querySelectorAll('.tabBtn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tabPanel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
    if (name === 'settings') { SettingsUI.refreshStats(); SettingsUI.refreshMemoryList(); }
    if (name === 'library') LibraryUI.onShow();
    if (name === 'solve') SolveUI.onShow();
  }

  function init() {
    document.querySelectorAll('.tabBtn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    ImportUI.init();
    LibraryUI.init();
    AnswerSheetImport.init();
    SolveUI.init();
    ExportPDF.init();
    SettingsUI.init();

    LibraryUI.refresh();
    switchTab('import');
  }

  return { switchTab, init };
})();

window.App = App;
window.addEventListener('DOMContentLoaded', App.init);
