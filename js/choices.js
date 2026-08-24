/* choices.js — 라이브러리 "선지 보기" 탭.
 *
 * 가져오기 탭에서 "선지 텍스트도 함께 추출"을 켜고 저장하면 생기는
 * IndexedDB `choices` 스토어(문제 이미지와 별개, 텍스트만)를 목록으로
 * 보여주고, 개별 태그/OX 체크/메모를 편집·저장하고, 필터링한 목록을
 * PDF로 내보낸다(ExportChoices 모듈, js/exportChoices.js).
 *
 * library.js의 "문제 보기"(가상스크롤)와 달리 이 목록은 항목이 텍스트뿐이라
 * 훨씬 가볍기 때문에 단순 렌더링(가상스크롤 없음)으로 구현했다. 다만 아주
 * 큰 라이브러리에서 DOM이 과도하게 커지는 걸 막기 위해 화면에는
 * RENDER_CAP개까지만 그리고(필터로 좁히도록 안내), 선택/내보내기 자체는
 * 화면에 그려진 개수와 무관하게 "필터링된 전체(filtered)" 기준으로 동작한다.
 */

const ChoicesUI = (() => {
  const RENDER_CAP = 400;
  const EMPTY_SENTINEL = '__EMPTY__';

  let fullList = [];
  let filtered = [];
  let selectedIds = new Set();
  let loaded = false;

  function el(sel, root = document) { return root.querySelector(sel); }
  function elAll(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function init() {
    el('#choiceSearch').addEventListener('input', debounce(applyFilters, 150));
    el('#choiceExamTypeFilter').addEventListener('change', applyFilters);
    el('#choiceSubjectFilter').addEventListener('change', applyFilters);
    el('#choiceYearFilter').addEventListener('change', applyFilters);
    el('#choiceTagFilter').addEventListener('change', applyFilters);
    el('#choiceOxFilter').addEventListener('change', applyFilters);

    el('#selectAllChoicesChk').addEventListener('change', (e) => {
      if (e.target.checked) filtered.forEach((c) => selectedIds.add(c.id));
      else selectedIds.clear();
      renderList();
    });

    el('#btnDeleteChoices').addEventListener('click', onDeleteSelected);
    el('#btnChoiceBulkTag').addEventListener('click', openBulkTagModal);
    el('#choiceBulkTagCancel').addEventListener('click', () => el('#choiceBulkTagModal').classList.add('hidden'));
    el('#choiceBulkTagApply').addEventListener('click', applyBulkTag);

    el('#btnChoiceBulkOx').addEventListener('click', openBulkOxModal);
    el('#choiceBulkOxCancel').addEventListener('click', () => el('#choiceBulkOxModal').classList.add('hidden'));
    el('#choiceBulkOxApply').addEventListener('click', applyBulkOx);

    el('#btnExportChoices').addEventListener('click', openExportModal);
    el('#choiceExportCancel').addEventListener('click', () => el('#choiceExportModal').classList.add('hidden'));
    el('#choiceExportRun').addEventListener('click', runExport);
  }

  /** 라이브러리 탭에서 "선지 보기"로 전환될 때마다 호출됨(library.js). 매번
   * DB에서 다시 읽어오므로 가져오기 직후에도 항상 최신 목록을 보장한다. */
  async function onShow() {
    await refresh();
  }

  async function refresh() {
    fullList = await DB.getAllChoices();
    fullList.sort((a, b) => (a.code || '').localeCompare(b.code || ''));
    loaded = true;
    populateFilterOptions();
    applyFilters();
  }

  function populateFilterOptions() {
    const examTypeValues = Array.from(new Set(fullList.map((c) => c.examType))).filter(Boolean).sort();
    const subjectValues = Array.from(new Set(fullList.map((c) => c.subject))).filter(Boolean).sort();
    const yearValues = Array.from(new Set(fullList.map((c) => c.examYear))).filter(Boolean).sort();
    const tagValues = Array.from(new Set(fullList.flatMap((c) => c.tags || []))).sort();

    fillSelect('#choiceExamTypeFilter', examTypeValues, '전체 시험유형');
    fillSelect('#choiceSubjectFilter', subjectValues, '전체 과목');
    fillSelect('#choiceYearFilter', yearValues, '전체 연도', (v) => v + '년');
    fillSelect('#choiceTagFilter', tagValues, '전체 태그');

    // 태그 자동완성(#allTagList)은 문제 태그 입력(#detailTags 등)과 공용이므로,
    // 이 목록만으로 덮어쓰지 않고 기존에 이미 채워진 옵션과 "합집합"으로 병합한다.
    mergeIntoGlobalTagList([...tagValues, ...(window.Tagger ? Tagger.allKnownTags() : [])]);
  }

  function mergeIntoGlobalTagList(newTags) {
    const dl = document.getElementById('allTagList');
    if (!dl) return;
    const existing = Array.from(dl.options).map((o) => o.value);
    const merged = Array.from(new Set([...existing, ...newTags])).filter(Boolean).sort();
    dl.innerHTML = merged.map((t) => `<option value="${escapeHtml(t)}">`).join('');
  }

  /** value 배열로 <option>들을 채운다. labelFn(v)가 있으면 표시 라벨만 다르게(예: "2024" -> "2024년"),
   * option의 value 자체는 항상 원래 값 그대로 유지한다(필터 비교는 value 기준이라야 하므로). */
  function fillSelect(sel, values, allLabel, labelFn) {
    const node = el(sel);
    const cur = node.value;
    node.innerHTML = `<option value="">${allLabel}</option>` +
      values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(labelFn ? labelFn(v) : v)}</option>`).join('');
    if (values.includes(cur)) node.value = cur;
  }

  function applyFilters() {
    const q = el('#choiceSearch').value.trim().toLowerCase();
    const examType = el('#choiceExamTypeFilter').value;
    const subject = el('#choiceSubjectFilter').value;
    const year = el('#choiceYearFilter').value;
    const tag = el('#choiceTagFilter').value;
    const ox = el('#choiceOxFilter').value;

    filtered = fullList.filter((c) => {
      if (examType && c.examType !== examType) return false;
      if (subject && c.subject !== subject) return false;
      if (year && c.examYear !== year) return false;
      if (tag && !(c.tags || []).includes(tag)) return false;
      if (ox === 'none') { if (c.ox) return false; }
      else if (ox && c.ox !== ox) return false;
      if (q) {
        const hay = [c.text, c.code, c.questionCode, c.examTitle, c.subject, (c.tags || []).join(','), c.memo]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    el('#choiceCount').textContent = `${filtered.length}개 선지 (전체 ${fullList.length}개)`;
    el('#choiceEmptyState').classList.toggle('hidden', filtered.length > 0 || !loaded);
    // 필터가 바뀌면 이전 선택이 뭘 가리키는지 헷갈리기 쉬우므로, 화면에 없는(=필터 밖) 선택은 유지하되
    // 셀렉트올 체크박스 표시만 새 filtered 기준으로 다시 계산한다(전체선택 해제 없이 이어서 작업 가능).
    renderList();
  }

  function renderList() {
    const container = el('#choiceList');
    const validIds = new Set(fullList.map((c) => c.id));
    Array.from(selectedIds).forEach((id) => { if (!validIds.has(id)) selectedIds.delete(id); });

    const shown = filtered.slice(0, RENDER_CAP);
    container.innerHTML = '';
    if (filtered.length > RENDER_CAP) {
      const notice = document.createElement('div');
      notice.className = 'hint';
      notice.style.margin = '4px 4px 10px';
      notice.textContent = `${filtered.length}개 중 ${RENDER_CAP}개만 표시됩니다. 검색/필터로 좁혀보세요. (선택·내보내기는 필터된 전체 ${filtered.length}개 기준으로 동작합니다)`;
      container.appendChild(notice);
    }
    shown.forEach((c) => container.appendChild(buildRow(c)));
    updateSelectionBar();
  }

  function buildRow(c) {
    const row = document.createElement('div');
    row.className = 'choiceRow';

    const head = document.createElement('div');
    head.className = 'choiceRowHead';
    head.innerHTML = `
      <label class="checkboxLabel choiceRowChk"><input type="checkbox" ${selectedIds.has(c.id) ? 'checked' : ''}></label>
      <span class="choiceMarker">${escapeHtml(PDFAnalyze.markerToPlain(c.marker))}</span>
      <div class="choiceRowMeta">
        <span class="rowCode">${escapeHtml(PDFAnalyze.prettifyMarkers(c.code) || '')}</span>
        <span class="rowCodeSub">${escapeHtml(c.examTitle || '')}${c.subject ? ' · ' + escapeHtml(c.subject) : ''}</span>
      </div>
      <div class="spacer"></div>
      <div class="oxToggle" role="group"></div>
      <button type="button" class="btnGhost choiceRowDelBtn" title="이 선지 삭제">✕</button>
    `;
    row.appendChild(head);

    head.querySelector('.choiceRowChk input').addEventListener('change', (e) => {
      if (e.target.checked) selectedIds.add(c.id); else selectedIds.delete(c.id);
      updateSelectionBar();
    });
    head.querySelector('.choiceRowDelBtn').addEventListener('click', () => deleteOne(c.id));

    const oxWrap = head.querySelector('.oxToggle');
    ['O', 'X', 'none'].forEach((val) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'oxBtn' + (val === 'none' ? ' oxBtnNone' : ' oxBtn' + val);
      btn.textContent = val === 'none' ? '미정' : val;
      const active = val === 'none' ? !c.ox : c.ox === val;
      btn.classList.toggle('active', active);
      btn.addEventListener('click', () => setOx(c, val === 'none' ? null : val, oxWrap));
      oxWrap.appendChild(btn);
    });

    const body = document.createElement('div');
    body.className = 'choiceRowBody';

    const textArea = document.createElement('textarea');
    textArea.className = 'choiceTextInput';
    textArea.rows = 2;
    textArea.value = c.text || '';
    textArea.addEventListener('blur', () => {
      const v = textArea.value.trim();
      if (v !== c.text) { c.text = v; DB.updateChoice(c); }
    });
    body.appendChild(textArea);

    const metaRow = document.createElement('div');
    metaRow.className = 'choiceRowFields';
    metaRow.innerHTML = `
      <label class="choiceFieldLabel">태그
        <input type="text" class="choiceTagsInput" list="allTagList" value="${escapeHtml((c.tags || []).join(', '))}" placeholder="쉼표로 구분">
      </label>
      <label class="choiceFieldLabel">메모
        <input type="text" class="choiceMemoInput" value="${escapeHtml(c.memo || '')}" placeholder="개인 메모">
      </label>
    `;
    body.appendChild(metaRow);
    row.appendChild(body);

    metaRow.querySelector('.choiceTagsInput').addEventListener('blur', (e) => {
      const tags = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
      c.tags = Array.from(new Set(tags));
      e.target.value = c.tags.join(', ');
      DB.updateChoice(c);
      mergeIntoGlobalTagList(c.tags);
    });
    metaRow.querySelector('.choiceMemoInput').addEventListener('blur', (e) => {
      const v = e.target.value.trim();
      if (v !== c.memo) { c.memo = v; DB.updateChoice(c); }
    });

    return row;
  }

  async function setOx(choice, val, oxWrapEl) {
    choice.ox = val;
    await DB.updateChoice(choice);
    elAll('.oxBtn, .oxBtnNone', oxWrapEl).forEach((btn, i) => {
      const vals = ['O', 'X', 'none'];
      btn.classList.toggle('active', val === null ? vals[i] === 'none' : vals[i] === val);
    });
  }

  async function deleteOne(id) {
    if (!confirm('이 선지를 삭제할까요? (문제 자체나 이미지는 지워지지 않습니다)')) return;
    await DB.deleteChoices([id]);
    selectedIds.delete(id);
    await refresh();
  }

  function updateSelectionBar() {
    el('#choiceSelectionCount').textContent = `${selectedIds.size}개 선택됨`;
    el('#btnDeleteChoices').disabled = selectedIds.size === 0;
    el('#selectAllChoicesChk').checked = filtered.length > 0 && filtered.every((c) => selectedIds.has(c.id));
  }

  /** 선택된 게 있으면 선택분, 없으면 확인 후 현재 필터된 전체(화면에 안 그려진 것 포함)를 대상으로 */
  function getSelectedOrConfirmAll(actionLabel) {
    if (selectedIds.size > 0) return fullList.filter((c) => selectedIds.has(c.id));
    if (filtered.length === 0) { alert('대상 선지가 없습니다.'); return []; }
    if (confirm(`선택된 선지가 없습니다. 현재 필터된 ${filtered.length}개 선지 전체를 ${actionLabel || '대상으로'} 할까요?`)) return filtered.slice();
    return [];
  }

  async function onDeleteSelected() {
    if (selectedIds.size === 0) return;
    if (!confirm(`선택한 ${selectedIds.size}개 선지를 삭제할까요? (문제 자체는 삭제되지 않습니다)`)) return;
    await DB.deleteChoices(Array.from(selectedIds));
    selectedIds.clear();
    await refresh();
  }

  // ---------------- 태그 일괄추가 ----------------

  let bulkTagTargets = [];
  function openBulkTagModal() {
    bulkTagTargets = getSelectedOrConfirmAll('태그 일괄추가');
    if (!bulkTagTargets.length) return;
    el('#choiceBulkTagInput').value = '';
    el('#choiceBulkTagModal').querySelector('input[name="choiceBulkTagMode"][value="add"]').checked = true;
    el('#choiceBulkTagModal').classList.remove('hidden');
  }
  async function applyBulkTag() {
    const raw = el('#choiceBulkTagInput').value.split(',').map((s) => s.trim()).filter(Boolean);
    if (!raw.length) { alert('추가할 태그를 입력해주세요.'); return; }
    const mode = el('#choiceBulkTagModal').querySelector('input[name="choiceBulkTagMode"]:checked').value;
    for (const c of bulkTagTargets) {
      const choice = await DB.getChoice(c.id);
      if (!choice) continue;
      choice.tags = mode === 'replace' ? raw.slice() : Array.from(new Set([...(choice.tags || []), ...raw]));
      await DB.updateChoice(choice);
    }
    bulkTagTargets = [];
    el('#choiceBulkTagModal').classList.add('hidden');
    await refresh();
  }

  // ---------------- OX 일괄지정 ----------------

  let bulkOxTargets = [];
  function openBulkOxModal() {
    bulkOxTargets = getSelectedOrConfirmAll('OX 일괄지정');
    if (!bulkOxTargets.length) return;
    el('#choiceBulkOxModal').classList.remove('hidden');
  }
  async function applyBulkOx() {
    const val = el('#choiceBulkOxModal').querySelector('input[name="choiceBulkOxVal"]:checked').value;
    const ox = val === 'none' ? null : val;
    for (const c of bulkOxTargets) {
      const choice = await DB.getChoice(c.id);
      if (!choice) continue;
      choice.ox = ox;
      await DB.updateChoice(choice);
    }
    bulkOxTargets = [];
    el('#choiceBulkOxModal').classList.add('hidden');
    await refresh();
  }

  // ---------------- 내보내기 ----------------

  let exportTargets = [];
  function openExportModal() {
    exportTargets = getSelectedOrConfirmAll('내보내기');
    if (!exportTargets.length) return;
    el('#choiceExportCount').textContent = `${exportTargets.length}개 선지 선택됨`;
    el('#choiceExportTitle').value = '';
    el('#choiceExportOrder').value = 'code';
    el('#choiceExportOxChk').checked = true;
    el('#choiceExportMemoChk').checked = true;
    el('#choiceExportOxOnlyChk').checked = false;
    el('#choiceExportStatus').textContent = '';
    el('#choiceExportModal').classList.remove('hidden');
  }

  async function runExport() {
    let list = exportTargets.slice();
    const order = el('#choiceExportOrder').value;
    if (order === 'code') list.sort((a, b) => (a.code || '').localeCompare(b.code || ''));
    const oxOnly = el('#choiceExportOxOnlyChk').checked;
    if (oxOnly) list = list.filter((c) => c.ox);
    if (!list.length) {
      el('#choiceExportStatus').textContent = '조건에 맞는 선지가 없습니다.';
      return;
    }
    const title = el('#choiceExportTitle').value.trim() || '선지 모음';
    const includeOx = el('#choiceExportOxChk').checked;
    const includeMemo = el('#choiceExportMemoChk').checked;

    const runBtn = el('#choiceExportRun');
    runBtn.disabled = true;
    el('#choiceExportStatus').textContent = '생성 중…';
    try {
      const blob = await window.ExportChoices.buildPdf(list, { title, includeOx, includeMemo });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) + '.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      el('#choiceExportStatus').textContent = '완료되었습니다.';
      setTimeout(() => el('#choiceExportModal').classList.add('hidden'), 800);
    } catch (err) {
      console.error(err);
      el('#choiceExportStatus').textContent = '오류: ' + err.message;
    } finally {
      runBtn.disabled = false;
    }
  }

  return { init, onShow, refresh };
})();

window.ChoicesUI = ChoicesUI;
