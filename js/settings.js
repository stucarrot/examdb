/* settings.js — 백업(JSON)/복원, 전체 삭제, 저장용량 안내
 * IndexedDB는 브라우저(기기)별로 로컬에만 저장되므로, 다른 컴퓨터에서도
 * 쓰려면 여기서 백업 파일을 내려받아 옮긴 뒤 "불러오기"로 복원해야 합니다.
 */

const SettingsUI = (() => {
  function el(sel, root = document) { return root.querySelector(sel); }

  function init() {
    el('#btnBackup').addEventListener('click', onBackup);
    el('#restoreFile').addEventListener('change', onRestoreFileChosen);
    el('#btnClearAll').addEventListener('click', onClearAll);
    el('#btnMemoryBackup').addEventListener('click', onMemoryBackup);
    el('#memoryRestoreFile').addEventListener('change', onMemoryRestoreFileChosen);
    el('#btnMemoryReset').addEventListener('click', onMemoryReset);
    refreshStats();
    refreshMemoryList();
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
    el('#backupStatus').textContent = '백업 파일 생성 중…';
    const data = await DB.exportAll((cur, total) => {
      el('#backupStatus').textContent = `백업 파일 생성 중… (${cur}/${total})`;
    });
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `exam-bank-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    el('#backupStatus').textContent = `백업 완료 (${data.questions.length}개 문제).`;
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

  return { init, refreshStats, refreshMemoryList };
})();

window.SettingsUI = SettingsUI;
