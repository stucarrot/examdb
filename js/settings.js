/* settings.js — 백업(JSON)/복원, 전체 삭제, 저장용량 안내
 * IndexedDB는 브라우저(기기)별로 로컬에만 저장되므로, 다른 컴퓨터에서도
 * 쓰려면 여기서 백업 파일을 내려받아 옮긴 뒤 "불러오기"로 복원해야 합니다.
 */

const SettingsUI = (() => {
  function el(sel, root = document) { return root.querySelector(sel); }

  let examList = []; // 백업 범위(일부만 선택)용: {id, title, subject, qcount}
  const selectedExamIds = new Set(); // 일부만 선택 모드에서 체크된 시험지 id

  function init() {
    el('#btnBackup').addEventListener('click', onBackup);
    el('#restoreFile').addEventListener('change', onRestoreFileChosen);
    el('#btnClearAll').addEventListener('click', onClearAll);
    el('#btnMemoryBackup').addEventListener('click', onMemoryBackup);
    el('#memoryRestoreFile').addEventListener('change', onMemoryRestoreFileChosen);
    el('#btnMemoryReset').addEventListener('click', onMemoryReset);
    el('#aiSettingsSaveBtn').addEventListener('click', onAiSettingsSave);
    el('#aiSettingsTestBtn').addEventListener('click', onAiSettingsTest);
    initBackupScopeUi();
    refreshStats();
    refreshMemoryList();
    refreshAiSettings();
  }

  // ==================== 백업 범위 선택 ====================

  function initBackupScopeUi() {
    el('#scopeQuestions').addEventListener('change', updateScopeUiState);
    el('#rangeAll').addEventListener('change', updateScopeUiState);
    el('#rangeFilter').addEventListener('change', () => { updateScopeUiState(); loadExamFilterListOnce(); });
    el('#examFilterAllBtn').addEventListener('click', () => { examList.forEach((e) => selectedExamIds.add(e.id)); renderExamFilterList(); });
    el('#examFilterNoneBtn').addEventListener('click', () => { selectedExamIds.clear(); renderExamFilterList(); });
    el('#examFilterSearch').addEventListener('input', renderExamFilterList);
    updateScopeUiState();
  }

  function updateScopeUiState() {
    const questionsOn = el('#scopeQuestions').checked;
    el('#scopeQuestionsSub').classList.toggle('hidden', !questionsOn);
    const filterMode = questionsOn && el('#rangeFilter').checked;
    el('#examFilterBox').classList.toggle('hidden', !filterMode);
  }

  let examListLoaded = false;
  async function loadExamFilterListOnce() {
    if (examListLoaded) return;
    examListLoaded = true;
    const exams = await DB.getAllExams();
    const questions = await DB.getAllQuestions();
    const counts = {};
    questions.forEach((q) => { counts[q.examId] = (counts[q.examId] || 0) + 1; });
    examList = exams
      .map((e) => ({ id: e.id, title: e.title || '(제목 없음)', subject: e.subject || '', qcount: counts[e.id] || 0 }))
      .sort((a, b) => a.title.localeCompare(b.title, 'ko'));
    el('#scopeAllCount').textContent = exams.length;
    // 기본은 전체 선택된 상태로 시작(사용자가 여기서 해제해 나가는 방식)
    examList.forEach((e) => selectedExamIds.add(e.id));
    renderExamFilterList();
  }

  function renderExamFilterList() {
    const q = (el('#examFilterSearch').value || '').trim().toLowerCase();
    const listEl = el('#examFilterList');
    listEl.innerHTML = '';
    const filtered = examList.filter((e) => !q || e.title.toLowerCase().includes(q) || e.subject.toLowerCase().includes(q));
    filtered.forEach((e) => {
      const row = document.createElement('label');
      row.className = 'examFilterRow';
      row.innerHTML = `<input type="checkbox" ${selectedExamIds.has(e.id) ? 'checked' : ''}>
        <span class="efTitle">${escapeHtml(e.title)}</span><span class="efMeta">${escapeHtml(e.subject)} · ${e.qcount}문제</span>`;
      row.querySelector('input').addEventListener('change', (ev) => {
        if (ev.target.checked) selectedExamIds.add(e.id); else selectedExamIds.delete(e.id);
        updateExamFilterCounts();
      });
      listEl.appendChild(row);
    });
    updateExamFilterCounts();
  }

  function updateExamFilterCounts() {
    const sel = examList.filter((e) => selectedExamIds.has(e.id));
    el('#examFilterSelCount').textContent = sel.length;
    el('#examFilterQCount').textContent = sel.reduce((s, e) => s + e.qcount, 0);
  }

  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  /** 현재 체크박스 상태 → DB.exportAll에 넘길 옵션 */
  function currentBackupOpts() {
    const includeSettings = el('#scopeSettings').checked;
    const includeQuestions = el('#scopeQuestions').checked;
    const includeExtras = el('#scopeExtras').checked;
    let examIds = null;
    if (includeQuestions && el('#rangeFilter').checked) examIds = Array.from(selectedExamIds);
    return { includeSettings, includeQuestions, examIds, includeExtras };
  }

  async function refreshStats() {
    const all = await DB.getAllQuestions();
    const exams = await DB.getAllExams();
    el('#statsQuestionCount').textContent = all.length;
    el('#statsExamCount').textContent = exams.length;
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const est = await navigator.storage.estimate();
        const usedMB = (est.usage / 1024 / 1024).toFixed(1);
        const quotaMB = (est.quota / 1024 / 1024).toFixed(0);
        el('#statsStorage').textContent = `${usedMB} MB 사용 중 (브라우저 허용량 약 ${quotaMB} MB)`;
      } catch (e) {
        el('#statsStorage').textContent = '알 수 없음';
      }
    }
  }

  async function onBackup() {
    const opts = currentBackupOpts();
    if (!opts.includeSettings && !opts.includeQuestions) {
      el('#backupStatus').textContent = '백업할 항목을 하나 이상 선택해주세요.';
      return;
    }
    if (opts.includeQuestions && opts.examIds && opts.examIds.length === 0) {
      el('#backupStatus').textContent = '"일부만 선택"을 골랐다면 문제지를 하나 이상 선택해주세요.';
      return;
    }
    el('#backupStatus').textContent = '백업 파일 생성 중…';
    const data = await DB.exportAll(opts, (cur, total) => {
      el('#backupStatus').textContent = `백업 파일 생성 중… (${cur}/${total})`;
    });
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const parts = [];
    if (opts.includeSettings) parts.push('설정');
    if (opts.includeQuestions) parts.push(opts.examIds ? '문제일부' : '문제전체');
    if (opts.includeQuestions && opts.includeExtras) parts.push('해설메모');
    a.download = `exam-bank-backup-${parts.join('-') || '빈백업'}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    const qCount = data.questions ? data.questions.length : 0;
    el('#backupStatus').textContent = opts.includeQuestions
      ? `백업 완료 (${qCount}개 문제${opts.includeSettings ? ' + 앱 설정' : ''}).`
      : `백업 완료 (앱 설정만).`;
  }

  async function onRestoreFileChosen(e) {
    const file = e.target.files[0];
    if (!file) return;
    const merge = el('#restoreMerge').checked;
    if (!merge && !confirm('기존 데이터를 모두 지우고 백업 파일로 교체합니다. 계속할까요?')) {
      e.target.value = '';
      return;
    }
    el('#backupStatus').textContent = '복원 중…';
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const n = await DB.importAll(data, {
        merge,
        onProgress: (cur, total) => (el('#backupStatus').textContent = `복원 중… (${cur}/${total})`),
      });
      el('#backupStatus').textContent = `복원 완료 (${n}개 문제).`;
      await refreshStats();
      window.LibraryUI && window.LibraryUI.refresh();
    } catch (err) {
      console.error(err);
      el('#backupStatus').textContent = '복원 실패: 올바른 백업 파일인지 확인해주세요.';
    } finally {
      e.target.value = '';
    }
  }

  async function onClearAll() {
    if (!confirm('정말로 모든 문제 데이터를 삭제할까요? 이 작업은 되돌릴 수 없습니다.')) return;
    if (!confirm('마지막 확인입니다. 백업을 먼저 받으셨나요? 삭제를 진행할까요?')) return;
    await DB.clearAll();
    await refreshStats();
    window.LibraryUI && window.LibraryUI.refresh();
    alert('모든 데이터가 삭제되었습니다.');
  }

  // ==================== 가져오기 자동완성 기억 ====================

  async function refreshMemoryList() {
    if (!window.ImportMemory) return;
    const entries = await ImportMemory.getAllSubjectEntries();
    el('#memoryEntryCount').textContent = entries.length;
    const listEl = el('#memoryEntryList');
    listEl.innerHTML = '';
    entries.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'memoryEntryRow';
      const main = document.createElement('div');
      main.className = 'memoryEntryMain';
      const subj = document.createElement('span');
      subj.className = 'memoryEntrySubject';
      subj.textContent = entry.subject;
      const type = document.createElement('span');
      type.className = 'memoryEntryType';
      type.textContent = '→ ' + entry.examType;
      main.appendChild(subj);
      main.appendChild(type);
      row.appendChild(main);
      const delBtn = document.createElement('button');
      delBtn.textContent = '잊기';
      delBtn.addEventListener('click', async () => {
        await ImportMemory.forgetSubject(entry.subject);
        refreshMemoryList();
      });
      row.appendChild(delBtn);
      listEl.appendChild(row);
    });
  }

  async function onMemoryBackup() {
    if (!window.ImportMemory) return;
    const data = await ImportMemory.exportData();
    const count = Object.keys((data.memory && data.memory.bySubject) || {}).length;
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `exam-bank-import-memory-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    el('#memoryStatus').textContent = `기억 백업 완료 (${count}개 과목).`;
  }

  async function onMemoryRestoreFileChosen(e) {
    const file = e.target.files[0];
    if (!file) return;
    const merge = el('#memoryRestoreMerge').checked;
    if (!merge && !confirm('기존에 기억된 내용을 모두 지우고 백업 파일로 교체합니다. 계속할까요?')) {
      e.target.value = '';
      return;
    }
    el('#memoryStatus').textContent = '기억 복원 중…';
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const n = await ImportMemory.importData(data, { merge });
      el('#memoryStatus').textContent = `기억 복원 완료 (총 ${n}개 과목).`;
      await refreshMemoryList();
    } catch (err) {
      console.error(err);
      el('#memoryStatus').textContent = '복원 실패: 올바른 백업 파일인지 확인해주세요.';
    } finally {
      e.target.value = '';
    }
  }

  async function onMemoryReset() {
    if (!confirm('가져오기 자동완성 기억(과목→시험유형)을 모두 지울까요? 문제 데이터에는 영향이 없습니다.')) return;
    await ImportMemory.resetAll();
    await refreshMemoryList();
    el('#memoryStatus').textContent = '기억을 초기화했습니다.';
  }

  // ==================== AI 자동 해설(Gemini) 설정 ====================
  // 키/모델/그라운딩 여부는 DB.setMeta로 이 브라우저에만 저장(AIExplain 모듈이 실제 사용).
  // 백업(exportAll)은 meta 스토어 중 API 키(geminiApiKey)만 걸러내고 내보내므로, 백업
  // 파일을 스터디원과 공유해도 키가 함께 새어나가지 않는다 — db.js SENSITIVE_META_KEYS 참고.

  async function refreshAiSettings() {
    if (!window.AIExplain) return;
    el('#aiApiKeyInput').value = await AIExplain.getApiKeysText();
    const model = await AIExplain.getModel();
    el('#aiModelInput').value = model === AIExplain.DEFAULT_MODEL ? '' : model;
    el('#aiModelInput').placeholder = AIExplain.DEFAULT_MODEL;
    el('#aiGroundingChk').checked = await AIExplain.getUseGrounding();
  }

  async function onAiSettingsSave() {
    await AIExplain.setApiKeysText(el('#aiApiKeyInput').value);
    await AIExplain.setModel(el('#aiModelInput').value);
    await AIExplain.setUseGrounding(el('#aiGroundingChk').checked);
    const n = (await AIExplain.getApiKeys()).length;
    el('#aiSettingsStatus').textContent = n ? `저장했습니다. (키 ${n}개 등록됨)` : '저장했습니다. (등록된 키 없음)';
    setTimeout(() => { if (el('#aiSettingsStatus').textContent.startsWith('저장했습니다')) el('#aiSettingsStatus').textContent = ''; }, 2500);
  }

  async function onAiSettingsTest() {
    await onAiSettingsSave();
    const btn = el('#aiSettingsTestBtn');
    const status = el('#aiSettingsStatus');
    btn.disabled = true;
    status.textContent = '연결 확인 중… (키가 여러 개면 하나씩 순서대로 확인합니다)';
    try {
      const { ok, total } = await AIExplain.testConnection();
      status.textContent = ok === total ? `✓ 등록된 키 ${total}개 모두 정상` : `⚠ ${total}개 중 ${ok}개만 정상 (나머지는 한도 초과 또는 잘못된 키일 수 있음)`;
    } catch (err) {
      status.textContent = '✕ ' + err.message;
    } finally {
      btn.disabled = false;
    }
  }

  return { init, refreshStats, refreshMemoryList };
})();

window.SettingsUI = SettingsUI;
