/* library.js — 라이브러리 탭: 문제지(papers) 보기, 문제 목록(가상스크롤)/필터/검색,
 * 상세 편집(태그/정답/해설/메모), 다중 선택(→ CBT풀기 / PDF내보내기 / 삭제), 정답 일괄 입력
 */

const LibraryUI = (() => {
  const ROW_H_LIST = 100;
  const ROW_H_CARD = 300;
  let allExams = [];
  let filteredExams = []; // "문제지 보기"에서 검색/필터 적용된 결과(전체선택은 이 목록 기준)
  let fullList = [];
  let filtered = [];
  let selectedIds = new Set();
  let selectedExamIds = new Set(); // 문제지(papers) 보기에서 다중 선택된 exam id들
  let pendingBulkMetaTargets = []; // "문제정보 일괄변경" 모달이 열려있는 동안 적용 대상으로 캡처해둔 문제 목록
  let pendingBulkExamMetaIds = []; // "문제지 정보 일괄변경" 모달이 열려있는 동안 적용 대상으로 캡처해둔 exam id 목록
  // "정답표 일괄 적용(시험/연도별)" 모달 상태: 정답표 분석 결과와, 그 시험
  // 유형/연도 범위에 속한 각 문제지별로 어떤 행이 매칭됐는지를 들고 있는다.
  let bulkApplyParsedRows = [];
  let bulkApplyAnswerCount = 0;
  let bulkApplyPreview = []; // [{ exam, candidates:[row,...], selectedIndex, status:'matched'|'ambiguous'|'none' }]
  // 과목/연도 필터 드롭다운에서 "값이 아예 안 들어있는 문제만" 골라 볼 수
  // 있게 하는 특수 옵션값(실제 과목명/연도와 절대 겹치지 않도록 사람이 쓸 일
  // 없는 문자열로 정함).
  const EMPTY_SENTINEL = '__EMPTY__';
  let currentDetailId = null;
  let detailObjectURLs = [];
  let detailPartsLayout = 'stack';
  let detailViewMode = 'all'; // 'all' | 'single' — 여러 이미지 조각을 나란히 볼지 한 장씩 볼지
  let detailIndex = 0;
  let detailNavList = [];   // 현재 뷰어에서 "이전 문제/다음 문제"로 이동할 수 있는 문제 목록(연 시점의 filtered 스냅샷)
  let detailNavIndex = -1;  // detailNavList 안에서 현재 문제의 위치
  let detailZoom = 1;       // 문제 뷰어 확대 배율(1 = 원래 맞춤 크기)
  const ZOOM_MIN = 0.5, ZOOM_MAX = 3, ZOOM_STEP = 0.25;
  let zoomPanState = null;  // 확대된 이미지를 드래그로 스크롤(팬)하는 동안의 상태
  let currentEditExamId = null;
  let currentView = 'questions'; // 'questions' | 'papers'
  let currentListMode = 'list'; // 'list' | 'card' — 문제 목록 표시 방식

  function el(sel, root = document) { return root.querySelector(sel); }
  function elAll(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

  function init() {
    el('#libViewQuestionsBtn').addEventListener('click', () => switchView('questions'));
    el('#libViewPapersBtn').addEventListener('click', () => switchView('papers'));

    el('#selectAllPapersChk').addEventListener('change', (e) => {
      if (e.target.checked) filteredExams.forEach((ex) => selectedExamIds.add(ex.id));
      else selectedExamIds.clear();
      renderPapers();
    });
    el('#btnDeleteSelectedPapers').addEventListener('click', onDeleteSelectedExams);
    el('#btnBulkExamMeta').addEventListener('click', () => {
      if (selectedExamIds.size === 0) return;
      pendingBulkExamMetaIds = Array.from(selectedExamIds);
      el('#bulkExamMetaYear').value = '';
      el('#bulkExamMetaType').value = '';
      el('#bulkExamMetaSubject').value = '';
      el('#bulkExamMetaRound').value = '';
      el('#bulkExamMetaModal').classList.remove('hidden');
    });
    el('#bulkExamMetaCancel').addEventListener('click', () => {
      pendingBulkExamMetaIds = [];
      el('#bulkExamMetaModal').classList.add('hidden');
    });
    el('#bulkExamMetaApply').addEventListener('click', applyBulkExamMeta);
    el('#papersSearch').addEventListener('input', debounce(applyPaperFilters, 150));
    el('#papersExamTypeFilter').addEventListener('change', applyPaperFilters);
    el('#papersSubjectFilter').addEventListener('change', applyPaperFilters);
    el('#papersYearFilter').addEventListener('change', applyPaperFilters);

    el('#libModeListBtn').addEventListener('click', () => switchListMode('list'));
    el('#libModeCardBtn').addEventListener('click', () => switchListMode('card'));

    el('#libSearch').addEventListener('input', debounce(applyFilters, 150));
    el('#libExamFilter').addEventListener('change', applyFilters);
    el('#libExamTypeFilter').addEventListener('change', applyFilters);
    el('#libSubjectFilter').addEventListener('change', applyFilters);
    el('#libYearFilter').addEventListener('change', applyFilters);
    el('#libTagFilter').addEventListener('change', applyFilters);
    el('#libAnswerFilterChk').addEventListener('change', applyFilters);
    el('#libList').addEventListener('scroll', renderVisible);
    el('#selectAllChk').addEventListener('change', (e) => {
      if (e.target.checked) filtered.forEach((q) => selectedIds.add(q.id));
      else selectedIds.clear();
      updateSelectionBar();
      renderVisible();
    });
    el('#btnCbtFromSelection').addEventListener('click', () => {
      const list = getSelectedOrConfirmAll();
      if (list.length) window.SolveUI.startWithQuestions(list);
    });
    el('#btnExportFromSelection').addEventListener('click', () => {
      const list = getSelectedOrConfirmAll();
      if (list.length) window.ExportPDF.openExportDialog(list);
    });
    el('#btnDeleteSelection').addEventListener('click', onDeleteSelected);
    el('#btnBulkMeta').addEventListener('click', () => {
      const list = getSelectedOrConfirmAll();
      if (!list.length) return;
      pendingBulkMetaTargets = list;
      el('#bulkMetaYear').value = '';
      el('#bulkMetaExamType').value = '';
      el('#bulkMetaSubject').value = '';
      el('#bulkMetaTags').value = '';
      el('#bulkMetaModal').querySelector('input[name="bulkMetaTagMode"][value="add"]').checked = true;
      el('#bulkMetaModal').classList.remove('hidden');
    });
    el('#bulkMetaCancel').addEventListener('click', () => {
      pendingBulkMetaTargets = [];
      el('#bulkMetaModal').classList.add('hidden');
    });
    el('#bulkMetaApply').addEventListener('click', applyBulkMeta);
    el('#btnBulkAnswer').addEventListener('click', () => openBulkAnswerModal());
    el('#btnTagManager').addEventListener('click', openTagManager);
    el('#tagMgrClose').addEventListener('click', () => el('#tagManagerModal').classList.add('hidden'));
    el('#tagMgrSearch').addEventListener('input', debounce(renderTagManagerList, 120));
    el('#tagMgrExamTypeClear').addEventListener('click', () => {
      elAll('#tagMgrExamTypeList input[type="checkbox"]').forEach((c) => { c.checked = false; });
      renderTagManagerList();
    });
    el('#tagMgrSubjectClear').addEventListener('click', () => {
      elAll('#tagMgrSubjectList input[type="checkbox"]').forEach((c) => { c.checked = false; });
      renderTagManagerList();
    });
    el('#bulkAnswerCancel').addEventListener('click', () => el('#bulkAnswerModal').classList.add('hidden'));
    el('#bulkAnswerApply').addEventListener('click', applyBulkAnswers);

    el('#btnBulkAnswerSheetApply').addEventListener('click', openBulkApplyModal);
    el('#bulkApplyCancel').addEventListener('click', closeBulkApplyModal);
    el('#bulkApplyAnalyze').addEventListener('click', onBulkApplyAnalyze);
    el('#bulkApplyRun').addEventListener('click', onBulkApplyRun);

    el('#detailClose').addEventListener('click', closeDetail);
    el('#detailSave').addEventListener('click', saveDetail);
    el('#detailDelete').addEventListener('click', deleteDetail);
    el('#detailViewToggle').addEventListener('click', toggleDetailViewMode);
    el('#detailPrevBtn').addEventListener('click', () => stepDetailImage(-1));
    el('#detailNextBtn').addEventListener('click', () => stepDetailImage(1));
    el('#detailPrevQBtn').addEventListener('click', () => stepDetailQuestion(-1));
    el('#detailNextQBtn').addEventListener('click', () => stepDetailQuestion(1));
    el('#detailZoomInBtn').addEventListener('click', () => setZoom(detailZoom + ZOOM_STEP));
    el('#detailZoomOutBtn').addEventListener('click', () => setZoom(detailZoom - ZOOM_STEP));
    el('#detailZoomLabel').addEventListener('click', () => setZoom(1));
    // Ctrl/Cmd + 휠로 확대축소(일반 휠은 이미지 셀 자체의 개별 스크롤에 그대로 사용됨)
    el('#detailImages').addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setZoom(detailZoom + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
    }, { passive: false });
    // 확대된 이미지를 마우스 드래그로 팬(스크롤)
    el('#detailImages').addEventListener('mousedown', (e) => {
      const cell = e.target.closest('.detailImgCell.zoomed');
      if (!cell || e.button !== 0) return;
      zoomPanState = { cell, startX: e.clientX, startY: e.clientY, scrollLeft: cell.scrollLeft, scrollTop: cell.scrollTop };
      cell.classList.add('grabbing');
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!zoomPanState) return;
      zoomPanState.cell.scrollLeft = zoomPanState.scrollLeft - (e.clientX - zoomPanState.startX);
      zoomPanState.cell.scrollTop = zoomPanState.scrollTop - (e.clientY - zoomPanState.startY);
    });
    document.addEventListener('mouseup', () => {
      if (zoomPanState) { zoomPanState.cell.classList.remove('grabbing'); zoomPanState = null; }
    });
    // 이미지 더블클릭으로 빠르게 확대/원래크기 토글
    el('#detailImages').addEventListener('dblclick', (e) => {
      if (!e.target.closest('.detailImgCell')) return;
      setZoom(detailZoom > 1.001 ? 1 : 2);
    });
    document.addEventListener('keydown', (e) => {
      if (el('#detailPanel').classList.contains('hidden')) return;
      if (e.key === 'Escape') { closeDetail(); return; }
      // 태그/해설/메모 등 입력창에 타이핑 중일 때는 화살표·+/-/0/PageUp/PageDown을 그대로 텍스트 입력으로 사용
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowLeft') stepDetailImage(-1);
      else if (e.key === 'ArrowRight') stepDetailImage(1);
      else if (e.key === 'PageUp') { e.preventDefault(); stepDetailQuestion(-1); }
      else if (e.key === 'PageDown') { e.preventDefault(); stepDetailQuestion(1); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(detailZoom + ZOOM_STEP); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom(detailZoom - ZOOM_STEP); }
      else if (e.key === '0') { e.preventDefault(); setZoom(1); }
    });
    // 뷰어가 열려 있는 동안 창 크기가 바뀌면 칸 크기가 달라지므로 줌 픽셀 계산을 다시 적용
    window.addEventListener('resize', () => {
      if (!el('#detailPanel').classList.contains('hidden')) applyZoom();
    });

    ['#examEditType', '#examEditYear', '#examEditSubject', '#examEditRound'].forEach((sel) => {
      el(sel).addEventListener('input', updateExamEditPreview);
    });
    el('#examEditCancel').addEventListener('click', () => el('#examEditModal').classList.add('hidden'));
    el('#examEditSave').addEventListener('click', saveExamEdit);

    window.addEventListener('resize', renderVisible);
  }

  /** 라이브러리 탭이 실제로 화면에 보여질 때 폭 기반 레이아웃(1~3단)을 다시 계산 */
  function onShow() {
    renderVisible();
    if (currentView === 'papers') renderPapers();
  }

  function switchListMode(mode) {
    if (currentListMode === mode) return;
    currentListMode = mode;
    el('#libModeListBtn').classList.toggle('active', mode === 'list');
    el('#libModeCardBtn').classList.toggle('active', mode === 'card');
    el('#libList').scrollTop = 0;
    renderVisible();
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function switchView(view) {
    currentView = view;
    el('#libViewQuestionsBtn').classList.toggle('active', view === 'questions');
    el('#libViewPapersBtn').classList.toggle('active', view === 'papers');
    el('#questionsView').classList.toggle('hidden', view !== 'questions');
    el('#papersView').classList.toggle('hidden', view !== 'papers');
    if (view === 'papers') renderPapers();
    else renderVisible();
  }

  async function refresh() {
    allExams = await DB.getAllExams();
    allExams.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    fullList = await DB.getAllQuestions();
    fullList.sort((a, b) => (a.code || '').localeCompare(b.code || ''));
    populateFilterOptions();
    applyFilters();
    populatePaperFilterOptions();
    applyPaperFilters(); // 내부에서 currentView === 'papers'일 때만 renderPapers() 호출
  }

  // ---------------- 문제지(papers) 보기 ----------------

  /** 문제 목록 필터(과목/연도/시험유형)와 같은 패턴을, 문제지 자체의 메타데이터 기준으로 만든다 */
  function populatePaperFilterOptions() {
    const examTypeValues = Array.from(new Set(allExams.map((e) => e.examType))).filter(Boolean).sort();
    const subjectValues = Array.from(new Set(allExams.map((e) => e.subject))).filter(Boolean).sort();
    const yearValues = Array.from(new Set(allExams.map((e) => e.year))).filter(Boolean).sort();
    fillSelect('#papersExamTypeFilter', examTypeValues, '전체 시험유형');
    fillSelect('#papersSubjectFilter', subjectValues, '전체 과목');
    fillSelect('#papersYearFilter', yearValues, '전체 연도');
  }

  function applyPaperFilters() {
    const q = el('#papersSearch').value.trim().toLowerCase();
    const examType = el('#papersExamTypeFilter').value;
    const subject = el('#papersSubjectFilter').value;
    const year = el('#papersYearFilter').value;

    filteredExams = allExams.filter((exam) => {
      if (examType && exam.examType !== examType) return false;
      if (subject && exam.subject !== subject) return false;
      if (year && exam.year !== year) return false;
      if (q) {
        const hay = [exam.title, exam.code, exam.subject, exam.examType, exam.round].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    el('#papersCount').textContent = `${filteredExams.length}개 문제지 (전체 ${allExams.length}개)`;
    if (currentView === 'papers') renderPapers();
  }

  function renderPapers() {
    const grid = el('#papersGrid');
    grid.innerHTML = '';
    el('#papersEmptyState').classList.toggle('hidden', filteredExams.length > 0);
    el('#papersEmptyState').textContent = allExams.length === 0
      ? '아직 가져온 문제지가 없습니다. "가져오기" 탭에서 PDF를 추가해보세요.'
      : '필터 조건에 맞는 문제지가 없습니다.';
    // 목록이 바뀌면(삭제 등) 더 이상 존재하지 않는 id는 선택에서 정리한다
    const validIds = new Set(allExams.map((e) => e.id));
    Array.from(selectedExamIds).forEach((id) => { if (!validIds.has(id)) selectedExamIds.delete(id); });

    filteredExams.forEach((exam) => {
      const count = fullList.filter((q) => q.examId === exam.id).length;
      const gradedCount = fullList.filter((q) => q.examId === exam.id && q.answer).length;
      const card = document.createElement('div');
      card.className = 'paperCard';
      if (selectedExamIds.has(exam.id)) card.classList.add('selected');
      card.innerHTML = `
        <label class="checkboxLabel paperCardCheck" data-role="select">
          <input type="checkbox" ${selectedExamIds.has(exam.id) ? 'checked' : ''}>
        </label>
        <div class="paperTitle">${escapeHtml(exam.title || '(제목 없음)')}</div>
        <div class="paperCode">${escapeHtml(exam.code || '')}</div>
        <div class="paperMeta">
          ${escapeHtml(exam.examType || '-')} · ${escapeHtml(exam.year || '-')}년 · ${escapeHtml(exam.subject || '-')}
          ${exam.round ? ' · ' + escapeHtml(exam.round) : ''}
        </div>
        <div class="paperStats">문제 ${count}개 · 정답입력 ${gradedCount}/${count}</div>
        <div class="paperActions">
          <button class="btnSecondary" data-act="view">문제 보기</button>
          <button class="btnSecondary" data-act="answer">정답 입력</button>
          <button class="btnGhost" data-act="edit">이름수정</button>
          <button class="btnDanger" data-act="delete">삭제</button>
        </div>
      `;
      card.querySelector('[data-role="select"] input').addEventListener('change', (e) => {
        if (e.target.checked) selectedExamIds.add(exam.id); else selectedExamIds.delete(exam.id);
        card.classList.toggle('selected', e.target.checked);
        updatePaperSelectionBar();
      });
      card.querySelector('[data-act="view"]').addEventListener('click', () => {
        switchView('questions');
        el('#libExamFilter').value = exam.id;
        applyFilters();
      });
      card.querySelector('[data-act="answer"]').addEventListener('click', () => openBulkAnswerModal(exam.id));
      card.querySelector('[data-act="edit"]').addEventListener('click', () => openExamEdit(exam.id));
      card.querySelector('[data-act="delete"]').addEventListener('click', () => onDeleteExam(exam.id));
      grid.appendChild(card);
    });
    updatePaperSelectionBar();
  }

  function updatePaperSelectionBar() {
    el('#paperSelectionCount').textContent = `${selectedExamIds.size}개 선택됨`;
    el('#btnDeleteSelectedPapers').disabled = selectedExamIds.size === 0;
    el('#btnBulkExamMeta').disabled = selectedExamIds.size === 0;
    el('#selectAllPapersChk').checked = filteredExams.length > 0 && filteredExams.every((ex) => selectedExamIds.has(ex.id));
  }

  async function onDeleteSelectedExams() {
    if (selectedExamIds.size === 0) return;
    const ids = Array.from(selectedExamIds);
    const names = allExams.filter((e) => ids.includes(e.id)).map((e) => e.title || '(제목 없음)');
    const totalQ = fullList.filter((q) => ids.includes(q.examId)).length;
    const preview = names.slice(0, 5).join(', ') + (names.length > 5 ? ` 외 ${names.length - 5}건` : '');
    if (!confirm(`문제지 ${ids.length}개(${preview})와 그 안의 문제 총 ${totalQ}개를 모두 삭제할까요? 되돌릴 수 없습니다.`)) return;
    for (const id of ids) {
      await DB.deleteExam(id);
    }
    selectedExamIds.clear();
    await refresh();
  }

  /**
   * 선택된 문제지들의 연도/시험유형/과목/책형을 한 번에 바꾼다. 빈 칸으로
   * 둔 항목은 건드리지 않는다. 문제 하나하나가 아니라 "문제지" 메타데이터
   * 자체를 바꾸는 것이므로, 20번(문제 쪽 일괄변경)과 달리 `DB.updateExam()`을
   * 그대로 써서 그 문제지에 속한 모든 문제의 캐시 필드/코드까지 함께 다시
   * 계산되도록 한다(문제 쪽 일괄변경이 "이 문제만 예외적으로" 오버라이드하는
   * 것과 달리, 이건 문제지 자체를 진짜로 바꾸는 정석 경로).
   */
  async function applyBulkExamMeta() {
    const ids = pendingBulkExamMetaIds;
    if (!ids || !ids.length) { el('#bulkExamMetaModal').classList.add('hidden'); return; }

    const yearVal = el('#bulkExamMetaYear').value.trim();
    const typeVal = el('#bulkExamMetaType').value.trim();
    const subjectVal = el('#bulkExamMetaSubject').value.trim();
    const roundVal = el('#bulkExamMetaRound').value.trim();

    if (!yearVal && !typeVal && !subjectVal && !roundVal) {
      alert('변경할 값을 하나 이상 입력해주세요.');
      return;
    }

    const changes = [];
    if (yearVal) changes.push(`연도 → ${yearVal}`);
    if (typeVal) changes.push(`시험유형 → ${typeVal}`);
    if (subjectVal) changes.push(`과목 → ${subjectVal}`);
    if (roundVal) changes.push(`책형 → ${roundVal}`);
    const totalQ = fullList.filter((q) => ids.includes(q.examId)).length;
    if (!confirm(`선택한 문제지 ${ids.length}개(소속 문제 총 ${totalQ}개)에 다음을 적용할까요?\n\n${changes.join('\n')}`)) return;

    for (const id of ids) {
      const exam = await DB.getExam(id);
      if (!exam) continue;
      if (yearVal) exam.year = yearVal;
      if (typeVal) exam.examType = typeVal;
      if (subjectVal) exam.subject = subjectVal;
      if (roundVal) exam.round = roundVal;
      await DB.updateExam(exam);
    }

    pendingBulkExamMetaIds = [];
    el('#bulkExamMetaModal').classList.add('hidden');
    await refresh();
  }

  function openExamEdit(examId) {
    const exam = allExams.find((e) => e.id === examId);
    if (!exam) return;
    currentEditExamId = examId;
    el('#examEditTitle').value = exam.title || '';
    el('#examEditType').value = exam.examType || '';
    el('#examEditYear').value = exam.year || '';
    el('#examEditSubject').value = exam.subject || '';
    el('#examEditRound').value = exam.round || '';
    updateExamEditPreview();
    el('#examEditModal').classList.remove('hidden');
  }

  function updateExamEditPreview() {
    const code = DB.Naming.examCode({
      examType: el('#examEditType').value.trim(),
      year: el('#examEditYear').value.trim(),
      subject: el('#examEditSubject').value.trim(),
      round: el('#examEditRound').value.trim(),
    });
    el('#examEditCodePreview').textContent = code || '-';
  }

  async function saveExamEdit() {
    if (!currentEditExamId) return;
    const exam = allExams.find((e) => e.id === currentEditExamId);
    exam.title = el('#examEditTitle').value.trim();
    exam.examType = el('#examEditType').value.trim();
    exam.year = el('#examEditYear').value.trim();
    exam.subject = el('#examEditSubject').value.trim();
    exam.round = el('#examEditRound').value.trim();
    await DB.updateExam(exam);
    el('#examEditModal').classList.add('hidden');
    currentEditExamId = null;
    await refresh();
    if (currentView === 'papers') renderPapers();
  }

  async function onDeleteExam(examId) {
    const exam = allExams.find((e) => e.id === examId);
    const count = fullList.filter((q) => q.examId === examId).length;
    if (!confirm(`"${exam ? exam.title : ''}" 문제지와 그 안의 문제 ${count}개를 모두 삭제할까요? 되돌릴 수 없습니다.`)) return;
    await DB.deleteExam(examId);
    await refresh();
  }

  // ---------------- 문제 목록 ----------------

  function populateFilterOptions() {
    const examOptions = allExams.map((e) => ({ value: e.id, label: `${e.title} (${e.code})` }));

    // 시험 유형(5급공채/7급공채/9급공채 등)도 과목/연도와 같은 패턴으로.
    const examTypeValues = Array.from(new Set(fullList.map((q) => q.examType))).filter(Boolean).sort();
    const examTypeOptions = examTypeValues.map((t) => ({ value: t, label: t }));
    if (fullList.some((q) => !q.examType)) {
      examTypeOptions.push({ value: EMPTY_SENTINEL, label: '(시험유형 미입력)' });
    }

    // 과목: 실제 값이 있는 것들 + (하나라도 비어있는 문제가 있으면) "과목
    // 미입력"을 별도 옵션으로 추가. 가져오기 확인 단계에서 과목을 안 적으면
    // 자동으로 '기타'라는 실제 텍스트가 들어가지만(그건 이미 일반 옵션으로
    // 걸러 볼 수 있다), 나중에 문제지 정보를 수정하면서 과목란을 완전히
    // 지운 경우처럼 진짜 빈 값도 있을 수 있어 그런 것도 따로 걸러 볼 수
    // 있게 한다.
    const subjectValues = Array.from(new Set(fullList.map((q) => q.subject))).filter(Boolean).sort();
    const subjectOptions = subjectValues.map((s) => ({ value: s, label: s }));
    if (fullList.some((q) => !q.subject)) {
      subjectOptions.push({ value: EMPTY_SENTINEL, label: '(과목 미입력)' });
    }

    // 연도도 마찬가지: 문제는 exam.year를 q.examYear로 캐시해서 들고 있다
    // (DB.updateExam 참고).
    const yearValues = Array.from(new Set(fullList.map((q) => q.examYear))).filter(Boolean).sort();
    const yearOptions = yearValues.map((y) => ({ value: y, label: `${y}년` }));
    if (fullList.some((q) => !q.examYear)) {
      yearOptions.push({ value: EMPTY_SENTINEL, label: '(연도 미입력)' });
    }

    const tags = Array.from(new Set(fullList.flatMap((q) => q.tags || []))).sort();

    fillSelectObjects('#libExamFilter', examOptions, '전체 문제지');
    fillSelectObjects('#libExamTypeFilter', examTypeOptions, '전체 시험유형');
    fillSelectObjects('#libSubjectFilter', subjectOptions, '전체 과목');
    fillSelectObjects('#libYearFilter', yearOptions, '전체 연도');
    fillSelect('#libTagFilter', tags, '전체 태그');
  }

  function fillSelect(sel, values, allLabel) {
    const node = el(sel);
    const cur = node.value;
    node.innerHTML = `<option value="">${allLabel}</option>` + values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    if (values.includes(cur)) node.value = cur;
  }

  function fillSelectObjects(sel, options, allLabel) {
    const node = el(sel);
    const cur = node.value;
    node.innerHTML = `<option value="">${allLabel}</option>` + options.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
    if (options.some((o) => o.value === cur)) node.value = cur;
  }

  function applyFilters() {
    const q = el('#libSearch').value.trim().toLowerCase();
    const examId = el('#libExamFilter').value;
    const examType = el('#libExamTypeFilter').value;
    const subject = el('#libSubjectFilter').value;
    const year = el('#libYearFilter').value;
    const tag = el('#libTagFilter').value;
    const ungradedOnly = el('#libAnswerFilterChk').checked;

    filtered = fullList.filter((item) => {
      if (examId && item.examId !== examId) return false;
      if (examType) {
        if (examType === EMPTY_SENTINEL) { if (item.examType) return false; }
        else if (item.examType !== examType) return false;
      }
      if (subject) {
        if (subject === EMPTY_SENTINEL) { if (item.subject) return false; }
        else if (item.subject !== subject) return false;
      }
      if (year) {
        if (year === EMPTY_SENTINEL) { if (item.examYear) return false; }
        else if (item.examYear !== year) return false;
      }
      if (tag && !(item.tags || []).includes(tag)) return false;
      if (ungradedOnly && item.answer) return false;
      if (q) {
        const hay = [item.code, item.examTitle, item.subject, String(item.qnum), (item.tags || []).join(','), item.memo, item.explanation]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    el('#libCount').textContent = `${filtered.length}개 문제 (전체 ${fullList.length}개)`;
    el('#libEmptyState').classList.toggle('hidden', filtered.length > 0);
    renderVisible();
    updateSelectionBar();
  }

  /** 화면 폭에 따라 목록형/카드형 각각 1~3단을 결정 */
  function computeCols(containerWidth) {
    const w = containerWidth || 0;
    if (currentListMode === 'card') {
      if (w >= 920) return 3;
      if (w >= 580) return 2;
      return 1;
    }
    if (w >= 1150) return 3;
    if (w >= 700) return 2;
    return 1;
  }

  function renderVisible() {
    const container = el('#libList');
    const phantom = el('#libListPhantom');
    const inner = el('#libListInner');

    const rowH = currentListMode === 'card' ? ROW_H_CARD : ROW_H_LIST;
    const cols = Math.max(1, computeCols(container.clientWidth - 20));
    const totalRows = Math.ceil(filtered.length / cols);
    phantom.style.height = totalRows * rowH + 'px';

    const scrollTop = container.scrollTop;
    const viewH = container.clientHeight || 500;
    const startRow = Math.max(0, Math.floor(scrollTop / rowH) - 2);
    const endRow = Math.min(totalRows, Math.ceil((scrollTop + viewH) / rowH) + 2);

    inner.style.transform = `translateY(${startRow * rowH}px)`;
    inner.innerHTML = '';
    for (let r = startRow; r < endRow; r++) {
      const rowDiv = document.createElement('div');
      rowDiv.className = 'libGridRow';
      rowDiv.style.height = rowH + 'px';
      rowDiv.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        if (idx >= filtered.length) break;
        const q = filtered[idx];
        rowDiv.appendChild(currentListMode === 'card' ? buildCard(q) : buildRow(q));
      }
      inner.appendChild(rowDiv);
    }
  }

  function buildRow(q) {
    const row = document.createElement('div');
    row.className = 'libRow';

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = selectedIds.has(q.id);
    chk.addEventListener('click', (e) => e.stopPropagation());
    chk.addEventListener('change', () => {
      if (chk.checked) selectedIds.add(q.id); else selectedIds.delete(q.id);
      updateSelectionBar();
    });
    row.appendChild(chk);

    const thumb = document.createElement('img');
    thumb.className = 'rowThumb';
    thumb.src = q.thumb || '';
    row.appendChild(thumb);

    const info = document.createElement('div');
    info.className = 'rowInfo';
    info.innerHTML = `
      <div class="rowCode">${escapeHtml(q.code || '')} <span class="rowCodeSub">· ${q.qnum}번${q.subject ? ' · ' + escapeHtml(q.subject) : ''}</span></div>
      <div class="rowTitleSub">${escapeHtml(q.examTitle || '')}</div>
      <div class="rowTags">${(q.tags || []).map((t) => `<span class="tagChip">${escapeHtml(t)}</span>`).join('')}</div>
    `;
    row.appendChild(info);

    const status = document.createElement('div');
    status.className = 'rowStatus';
    status.innerHTML = `
      <span class="badge ${q.answer ? 'badge-ok' : 'badge-warn'}">${q.answer ? '정답 ' + q.answer : '정답 미입력'}</span>
      <span class="badge ${q.explanation ? 'badge-ok' : 'badge-muted'}">${q.explanation ? '해설 있음' : '해설 없음'}</span>
    `;
    row.appendChild(status);

    row.addEventListener('click', (e) => {
      if (e.target === chk) return;
      openDetail(q.id);
    });

    return row;
  }

  /** 카드형(세로) — 썸네일 미리보기가 크게 보이도록 */
  function buildCard(q) {
    const card = document.createElement('div');
    card.className = 'libCard';

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'libCardThumbWrap';

    const thumb = document.createElement('img');
    thumb.className = 'libCardThumb';
    thumb.src = q.thumb || '';
    thumbWrap.appendChild(thumb);

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'libCardChk';
    chk.checked = selectedIds.has(q.id);
    chk.addEventListener('click', (e) => e.stopPropagation());
    chk.addEventListener('change', () => {
      if (chk.checked) selectedIds.add(q.id); else selectedIds.delete(q.id);
      updateSelectionBar();
    });
    thumbWrap.appendChild(chk);
    card.appendChild(thumbWrap);

    const body = document.createElement('div');
    body.className = 'libCardBody';
    body.innerHTML = `
      <div class="libCardCode">${escapeHtml(q.code || '')} · ${q.qnum}번</div>
      <div class="libCardTitleSub">${escapeHtml(q.examTitle || '')}</div>
      <div class="libCardTags">${(q.tags || []).map((t) => `<span class="tagChip">${escapeHtml(t)}</span>`).join('')}</div>
      <div class="libCardStatus">
        <span class="badge ${q.answer ? 'badge-ok' : 'badge-warn'}">${q.answer ? '정답 ' + q.answer : '정답 미입력'}</span>
        <span class="badge ${q.explanation ? 'badge-ok' : 'badge-muted'}">${q.explanation ? '해설 있음' : '해설 없음'}</span>
      </div>
    `;
    card.appendChild(body);

    card.addEventListener('click', () => openDetail(q.id));
    return card;
  }

  function updateSelectionBar() {
    el('#selectionCount').textContent = `${selectedIds.size}개 선택됨`;
    el('#btnDeleteSelection').disabled = selectedIds.size === 0;
  }

  function getSelectedOrConfirmAll() {
    if (selectedIds.size > 0) return fullList.filter((q) => selectedIds.has(q.id));
    if (filtered.length === 0) { alert('대상 문제가 없습니다.'); return []; }
    if (confirm(`선택된 문제가 없습니다. 현재 필터된 ${filtered.length}개 문제 전체를 사용할까요?`)) return filtered.slice();
    return [];
  }

  async function onDeleteSelected() {
    if (selectedIds.size === 0) return;
    if (!confirm(`선택한 ${selectedIds.size}개 문제를 삭제할까요? 되돌릴 수 없습니다.`)) return;
    await DB.deleteQuestions(Array.from(selectedIds));
    selectedIds.clear();
    await refresh();
  }

  /**
   * @param {string} id 열 문제의 id
   * @param {Array|null} navList "이전 문제/다음 문제"로 이동할 목록. 생략하면 현재 필터된 목록(filtered)을
   *   그대로 쓴다 — 목록/카드에서 처음 열 때는 항상 filtered, 뷰어 안에서 이전/다음으로 넘어갈 때는
   *   기존에 열려있던 navList를 그대로 이어받는다(stepDetailQuestion에서 전달).
   */
  async function openDetail(id, navList) {
    const q = await DB.getQuestion(id);
    if (!q) return;
    currentDetailId = id;
    detailObjectURLs.forEach((u) => URL.revokeObjectURL(u));
    detailObjectURLs = await DB.getImageURLs(q);
    detailPartsLayout = q.partsLayout === 'row' ? 'row' : 'stack';
    detailViewMode = 'all';
    detailIndex = 0;
    detailZoom = 1;

    detailNavList = navList || filtered;
    detailNavIndex = detailNavList.findIndex((item) => item.id === id);

    el('#detailTitle').textContent = `${q.code} · ${q.qnum}번`;
    el('#detailSubtitle').textContent = q.examTitle || '';
    el('#detailTags').value = (q.tags || []).join(', ');
    el('#detailAnswer').value = q.answer || '';
    el('#detailExplanation').value = q.explanation || '';
    el('#detailMemo').value = q.memo || '';

    updateDetailNav();
    renderDetailImages();
    el('#detailPanel').classList.remove('hidden');
  }

  /** 상단바의 "이전 문제/다음 문제" 버튼 활성/비활성 상태 및 위치 표시(n / 전체) 갱신 */
  function updateDetailNav() {
    const total = detailNavList.length;
    const has = total > 0 && detailNavIndex >= 0;
    el('#detailPrevQBtn').disabled = !has || detailNavIndex <= 0;
    el('#detailNextQBtn').disabled = !has || detailNavIndex >= total - 1;
    el('#detailNavPos').textContent = has ? `${detailNavIndex + 1} / ${total}` : '';
  }

  /** 현재 문제 목록(detailNavList) 안에서 이전(-1)/다음(+1) 문제로 이동 */
  function stepDetailQuestion(delta) {
    if (detailNavIndex < 0) return;
    const newIndex = detailNavIndex + delta;
    if (newIndex < 0 || newIndex >= detailNavList.length) return;
    openDetail(detailNavList[newIndex].id, detailNavList);
  }

  /** 전체화면 뷰어의 이미지 영역 렌더링 — '나란히 보기'(균등 분할)와 '한 장씩 보기'(화살표 이동)를 전환 */
  function renderDetailImages() {
    const imgs = detailObjectURLs;
    const multi = imgs.length > 1;
    const wrap = el('#detailImages');

    el('#detailViewToggle').classList.toggle('hidden', !multi);
    el('#detailViewToggle').textContent = detailViewMode === 'all' ? '⊞ 한 장씩 보기' : '▦ 나란히 보기';
    el('#detailPrevBtn').classList.toggle('hidden', !(multi && detailViewMode === 'single'));
    el('#detailNextBtn').classList.toggle('hidden', !(multi && detailViewMode === 'single'));
    el('#detailImageCounter').classList.toggle('hidden', !(multi && detailViewMode === 'single'));
    if (multi && detailViewMode === 'single') {
      el('#detailImageCounter').textContent = `${detailIndex + 1} / ${imgs.length}`;
    }

    // 1장을 볼 때도 "여러 장을 나란히 볼 때 쓰는 것과 동일한 그리드(칸=1개)"를 그대로 재사용한다.
    // 이렇게 하면 1장 보기의 기본(줌 100%) 크기가 "칸이 뷰어 전체를 꽉 채운다"는 동일한 기준을 갖게 되고,
    // 확대/스크롤 로직도 별도 분기 없이 완전히 동일하게 동작한다.
    const showImgs = (!multi || detailViewMode === 'single')
      ? [imgs[Math.min(detailIndex, imgs.length - 1)] || '']
      : imgs;
    wrap.className = 'detailImages ' + (detailPartsLayout === 'row' ? 'layout-row' : 'layout-stack');
    wrap.style.setProperty('--n', String(showImgs.length));
    wrap.innerHTML = showImgs
      .map((u) => (u ? `<div class="detailImgCell"><img src="${u}" class="detailImg"></div>` : ''))
      .join('');
    applyZoom();
  }

  /** 확대 배율(detailZoom)을 min/max로 제한하고 화면에 반영 */
  function setZoom(next) {
    detailZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    applyZoom();
  }

  /**
   * 현재 detailZoom을 화면의 모든 .detailImgCell(1장/여러 장 공용)에 적용.
   *
   * 퍼센트(%) 기반이 아니라 "이미지 원본 픽셀 크기 × 배율(px)"로 직접 계산해서 적용한다.
   * 이유: width/height를 칸(container) 대비 %로 주면, 칸 종횡비와 이미지 종횡비가 다를 때
   * object-fit:contain과 얽혀서 배율 1 부근에서 방향에 따라 계산이 어긋나거나(줌아웃이 안 먹는 것처럼
   * 보임), 그리드 트랙 크기 계산 타이밍과 얽혀 실제로는 스타일이 바뀌어도 시각적으로 그대로인 것처럼
   * 보이는 경우가 있었다. 아래처럼 항상 절대 px 크기를 계산해서 넣으면 그런 문제가 없다:
   *   1) 이미지의 실제 원본 크기(naturalWidth/Height)와 칸의 현재 크기(clientWidth/Height)로
   *      "칸에 맞춤(축소만, 확대는 안 함)" 배율(fitScale)을 구하고,
   *   2) 최종 배율 = fitScale × detailZoom 을 원본 크기에 곱해 실제 px width/height로 지정한다.
   * detailZoom=1이면 기존과 동일한 "칸에 맞춤" 크기가 그대로 나오고, 1보다 크면 칸보다 커져서
   * 칸의 overflow:auto로 스크롤이 생기고, 1보다 작으면 기본보다 더 작아진다(축소도 정상 동작).
   */
  function applyZoom() {
    el('#detailZoomLabel').textContent = Math.round(detailZoom * 100) + '%';
    el('#detailZoomOutBtn').disabled = detailZoom <= ZOOM_MIN + 0.001;
    el('#detailZoomInBtn').disabled = detailZoom >= ZOOM_MAX - 0.001;

    elAll('.detailImgCell').forEach((cell) => {
      const img = cell.querySelector('.detailImg');
      if (!img) return;
      cell.classList.toggle('zoomed', detailZoom > 1.001);
      const sizeNow = () => {
        const nw = img.naturalWidth, nh = img.naturalHeight;
        const cw = cell.clientWidth, ch = cell.clientHeight;
        if (!nw || !nh || !cw || !ch) return;
        const fitScale = Math.min(cw / nw, ch / nh, 1);
        const scale = fitScale * detailZoom;
        img.style.width = Math.round(nw * scale) + 'px';
        img.style.height = Math.round(nh * scale) + 'px';
        if (detailZoom <= 1.001) { cell.scrollLeft = 0; cell.scrollTop = 0; }
      };
      if (img.complete && img.naturalWidth) sizeNow();
      else img.addEventListener('load', sizeNow, { once: true });
    });
  }

  function toggleDetailViewMode() {
    if (detailObjectURLs.length <= 1) return;
    detailViewMode = detailViewMode === 'all' ? 'single' : 'all';
    renderDetailImages();
  }

  function stepDetailImage(delta) {
    if (detailObjectURLs.length <= 1) return;
    if (detailViewMode !== 'single') detailViewMode = 'single';
    const n = detailObjectURLs.length;
    detailIndex = (detailIndex + delta + n) % n;
    renderDetailImages();
  }

  function closeDetail() {
    el('#detailPanel').classList.add('hidden');
    detailObjectURLs.forEach((u) => URL.revokeObjectURL(u));
    detailObjectURLs = [];
    currentDetailId = null;
    detailNavList = [];
    detailNavIndex = -1;
    zoomPanState = null;
  }

  async function saveDetail() {
    if (!currentDetailId) return;
    const id = currentDetailId;
    const q = await DB.getQuestion(id);
    q.tags = el('#detailTags').value.split(',').map((s) => s.trim()).filter(Boolean);
    q.answer = el('#detailAnswer').value.trim();
    q.explanation = el('#detailExplanation').value;
    q.memo = el('#detailMemo').value;
    await DB.updateQuestion(q);
    await refresh();
    // 뷰어는 닫지 않고 그대로 열어둔 채, 새로고침된 목록에서 같은 문제를 다시 찾아
    // detailNavList/detailNavIndex를 최신 상태로 맞춰준다(이전/다음 이동이 새 데이터 기준으로 동작하도록).
    if (currentDetailId === id) {
      detailNavList = filtered.some((item) => item.id === id) ? filtered : detailNavList;
      detailNavIndex = detailNavList.findIndex((item) => item.id === id);
      updateDetailNav();
      flashSaved();
    }
  }

  let savedFlashTimer = null;
  /** 저장 버튼 옆에 "저장됨" 표시를 잠깐 띄웠다 사라지게 한다(뷰어가 안 닫히니 저장됐다는 피드백이 필요) */
  function flashSaved() {
    const btn = el('#detailSave');
    if (!btn) return;
    clearTimeout(savedFlashTimer);
    const original = btn.dataset.origText || btn.textContent;
    btn.dataset.origText = original;
    btn.textContent = '저장됨 ✓';
    savedFlashTimer = setTimeout(() => { btn.textContent = original; }, 1200);
  }

  async function deleteDetail() {
    if (!currentDetailId) return;
    if (!confirm('이 문제를 삭제할까요?')) return;
    await DB.deleteQuestions([currentDetailId]);
    closeDetail();
    await refresh();
  }

  async function applyBulkAnswers() {
    const examId = el('#bulkAnswerExam').value;
    const text = el('#bulkAnswerText').value;
    if (!examId) { alert('문제지를 선택해주세요.'); return; }

    const pairs = [];
    text.split(/\r?\n/).forEach((line) => {
      const cleaned = line.trim().replace(/[:,\-.\)]/g, ' ').replace(/\s+/g, ' ');
      if (!cleaned) return;
      const parts = cleaned.split(' ');
      if (parts.length >= 2 && /^\d{1,3}$/.test(parts[0]) && /^\d{1,2}$/.test(parts[1])) {
        pairs.push([parseInt(parts[0], 10), parts[1]]);
      }
    });
    if (pairs.length === 0) { alert('인식된 정답이 없습니다. "문제번호 정답" 형식으로 한 줄씩 입력해주세요. 예) 1 3'); return; }

    const targets = fullList.filter((q) => q.examId === examId);
    let applied = 0;
    for (const [qnum, answer] of pairs) {
      const q = targets.find((t) => t.qnum === qnum);
      if (q) {
        q.answer = String(answer);
        await DB.updateQuestion(q);
        applied++;
      }
    }
    alert(`${applied}개 문제에 정답을 반영했습니다.`);
    el('#bulkAnswerModal').classList.add('hidden');
    el('#bulkAnswerText').value = '';
    await refresh();
  }

  function openBulkAnswerModalPrep(preselectExamId) {
    fillSelectObjects('#bulkAnswerExam', allExams.map((e) => ({ value: e.id, label: `${e.title} (${e.code})` })), '문제지 선택');
    if (preselectExamId) el('#bulkAnswerExam').value = preselectExamId;
  }

  /** "정답 일괄 입력" 모달을 연다. 문제지 카드의 "정답 입력" 버튼처럼 특정
   * 문제지를 미리 선택해두고 싶을 때 examId를 넘긴다(문제 보기 상단의
   * 일반 버튼은 examId 없이 호출해 빈 선택 상태로 연다). */
  function openBulkAnswerModal(examId) {
    openBulkAnswerModalPrep(examId);
    if (window.AnswerSheetImport) AnswerSheetImport.resetUI();
    const fileInput = el('#bulkAnswerSheetFile');
    if (fileInput) fileInput.value = '';
    el('#bulkAnswerModal').classList.remove('hidden');
  }

  // ================= 정답표 일괄 적용(시험/연도별) =================
  // "정답 일괄 입력"(단일 문제지)과 달리, 시험유형+연도로 문제지를 여러 개
  // 한꺼번에 묶어서 정답표 한 장으로 전부 채운다(예: 58과목짜리 시험을
  // 문제지 58개로 각각 가져온 경우, 정답표 PDF 하나만 첨부하면 전부 반영).

  function openBulkApplyModal() {
    bulkApplyParsedRows = [];
    bulkApplyAnswerCount = 0;
    bulkApplyPreview = [];
    el('#bulkApplyFile').value = '';
    el('#bulkApplyStatus').textContent = '';
    el('#bulkApplyResultStatus').textContent = '';
    el('#bulkApplyPreviewWrap').classList.add('hidden');
    el('#bulkApplyPreviewList').innerHTML = '';
    el('#bulkApplyRun').disabled = true;

    const examTypes = Array.from(new Set(allExams.map((e) => e.examType))).filter(Boolean).sort();
    const years = Array.from(new Set(allExams.map((e) => e.year))).filter(Boolean).sort();
    fillSelect('#bulkApplyExamType', examTypes, '시험유형 선택');
    fillSelect('#bulkApplyYear', years, '연도 선택');
    el('#bulkAnswerSheetApplyModal').classList.remove('hidden');
  }

  function closeBulkApplyModal() {
    el('#bulkAnswerSheetApplyModal').classList.add('hidden');
  }

  function scopedExamsForBulkApply() {
    const examType = el('#bulkApplyExamType').value;
    const year = el('#bulkApplyYear').value;
    return allExams.filter((e) => (!examType || e.examType === examType) && (!year || String(e.year) === String(year)));
  }

  async function onBulkApplyAnalyze() {
    const statusEl = el('#bulkApplyStatus');
    const file = el('#bulkApplyFile').files && el('#bulkApplyFile').files[0];
    const examType = el('#bulkApplyExamType').value;
    const year = el('#bulkApplyYear').value;
    el('#bulkApplyPreviewWrap').classList.add('hidden');
    el('#bulkApplyResultStatus').textContent = '';
    el('#bulkApplyRun').disabled = true;

    if (!examType || !year) { statusEl.textContent = '시험유형과 연도를 먼저 선택해주세요.'; return; }
    if (!file) { statusEl.textContent = '정답표 파일(PDF 또는 이미지)을 선택해주세요.'; return; }
    const scoped = scopedExamsForBulkApply();
    if (scoped.length === 0) { statusEl.textContent = '선택한 시험유형/연도에 해당하는 문제지가 없습니다.'; return; }

    statusEl.textContent = '정답표 분석 중…';
    try {
      const { rows, answerCount } = await AnswerSheetImport.analyzeFile(file);
      if (!rows.length) {
        statusEl.textContent = '정답표에서 표를 인식하지 못했습니다. (PDF는 텍스트 선택이 가능한 파일인지, 이미지는 표가 선명한지 확인해주세요)';
        return;
      }
      bulkApplyParsedRows = rows;
      bulkApplyAnswerCount = answerCount;

      bulkApplyPreview = scoped.map((exam) => {
        let candidates = AnswerSheetImport.findSubjectCandidates(rows, exam.subject);
        if (candidates.length > 1 && exam.round) {
          const roundFiltered = candidates.filter((r) => AnswerSheetImport.roundsMatch(r.round, exam.round));
          if (roundFiltered.length) candidates = roundFiltered;
        }
        let status = 'none';
        if (candidates.length === 1) status = 'matched';
        else if (candidates.length > 1) status = 'ambiguous';
        // 매칭/후보가 있는 문제지는 기본으로 체크(적용 대상)해두고,
        // 사용자가 특정 문제지만 골라 체크 해제할 수 있게 한다.
        return { exam, candidates, selectedIndex: 0, status, included: status !== 'none' };
      });

      renderBulkApplyPreview();
      el('#bulkApplyPreviewWrap').classList.remove('hidden');
      const matchedCount = bulkApplyPreview.filter((p) => p.status !== 'none').length;
      statusEl.textContent = `문제지 ${scoped.length}개 중 ${matchedCount}개에서 일치하는 과목을 찾았습니다. 적용하지 않을 문제지는 체크를 해제한 뒤 "일괄 적용"을 눌러주세요.`;
      updateBulkApplyRunEnabled();
    } catch (err) {
      console.error(err);
      statusEl.textContent = '오류: ' + err.message;
    }
  }

  function renderBulkApplyPreview() {
    const wrap = el('#bulkApplyPreviewList');
    wrap.innerHTML = bulkApplyPreview.map((p, idx) => {
      const badge = p.status === 'matched'
        ? `<span class="bulkApplyBadge ok">매칭됨</span>`
        : p.status === 'ambiguous'
          ? `<span class="bulkApplyBadge warn">후보 ${p.candidates.length}개</span>`
          : `<span class="bulkApplyBadge bad">매칭 실패</span>`;
      let selectHtml = '';
      if (p.status === 'ambiguous') {
        const opts = p.candidates.map((c, i) => {
          const filled = c.answers.filter((a) => a !== undefined && a !== '').length;
          return `<option value="${i}">${escapeHtml(c.subject)} · ${escapeHtml(c.round || '책형 미상')}책형 (${filled}문항)</option>`;
        }).join('');
        selectHtml = `<select data-idx="${idx}" class="bulkApplyCandidateSelect" ${p.included ? '' : 'disabled'}>${opts}</select>`;
      }
      // 매칭 실패(status='none')는 애초에 적용 대상이 아니므로 체크박스 자체가
      // 의미 없어 숨긴다. 매칭됨/후보있음만 체크박스로 적용 여부를 고를 수 있게 함.
      const checkHtml = p.status !== 'none'
        ? `<label class="checkboxLabel bulkApplyIncludeCheck"><input type="checkbox" data-include-idx="${idx}" ${p.included ? 'checked' : ''}></label>`
        : `<span class="bulkApplyIncludeCheck"></span>`;
      return `<div class="bulkApplyPreviewRow ${p.included ? '' : 'excluded'}">
        ${checkHtml}
        <span class="bulkApplyPreviewTitle">${escapeHtml(p.exam.title || p.exam.code)} <span class="hint">(${escapeHtml(p.exam.subject || '과목 미입력')}${p.exam.round ? ' · ' + escapeHtml(p.exam.round) + '책형' : ''})</span></span>
        ${selectHtml}
        ${badge}
      </div>`;
    }).join('');

    elAll('.bulkApplyCandidateSelect', wrap).forEach((sel) => {
      sel.addEventListener('change', (e) => {
        const idx = parseInt(e.target.dataset.idx, 10);
        bulkApplyPreview[idx].selectedIndex = parseInt(e.target.value, 10);
      });
    });
    elAll('[data-include-idx]', wrap).forEach((chk) => {
      chk.addEventListener('change', (e) => {
        const idx = parseInt(e.target.dataset.includeIdx, 10);
        bulkApplyPreview[idx].included = e.target.checked;
        renderBulkApplyPreview();
        updateBulkApplyRunEnabled();
      });
    });
  }

  function updateBulkApplyRunEnabled() {
    const includedCount = bulkApplyPreview.filter((p) => p.status !== 'none' && p.included).length;
    el('#bulkApplyRun').disabled = includedCount === 0;
  }

  async function onBulkApplyRun() {
    const resolvable = bulkApplyPreview.filter((p) => p.status !== 'none' && p.included);
    if (resolvable.length === 0) return;
    if (!confirm(`문제지 ${resolvable.length}개에 정답표 인식 결과를 반영할까요? (이미 입력된 정답은 덮어써집니다)`)) return;

    el('#bulkApplyRun').disabled = true;
    el('#bulkApplyResultStatus').textContent = '적용 중…';

    let examsApplied = 0, questionsApplied = 0;
    for (const p of resolvable) {
      const row = p.candidates[p.selectedIndex] || p.candidates[0];
      if (!row) continue;
      const targets = fullList.filter((q) => q.examId === p.exam.id);
      let appliedInExam = 0;
      for (let i = 0; i < row.answers.length; i++) {
        const answer = row.answers[i];
        if (answer === undefined || answer === '') continue;
        const qnum = i + 1;
        const q = targets.find((t) => t.qnum === qnum);
        if (q) {
          q.answer = String(answer);
          await DB.updateQuestion(q);
          appliedInExam++;
        }
      }
      if (appliedInExam > 0) { examsApplied++; questionsApplied += appliedInExam; }
    }

    el('#bulkApplyResultStatus').textContent = `완료: 문제지 ${examsApplied}개, 총 ${questionsApplied}문항에 정답을 반영했습니다.`;
    el('#bulkApplyRun').disabled = false;
    await refresh();
  }

  /**
   * 선택된 문제들의 연도/시험유형/과목/태그를 한 번에 바꾼다. 빈 칸으로 둔
   * 항목은 건드리지 않는다(문제별로 값이 달라도 그대로 유지됨). 태그만
   * "기존에 추가"/"전체 교체" 두 방식을 고를 수 있다.
   *
   * 주의: 연도/시험유형/과목은 원래 문제지(exam) 쪽 메타데이터를 문제마다
   * 복사해서 캐시해둔 값이다(DB.updateExam 참고). 이 기능으로 문제별로
   * 따로 바꿔두더라도, 나중에 그 문제가 속한 문제지 정보를 "문제지 보기"에서
   * 다시 수정하면 그 문제지에 속한 모든 문제가 문제지 값으로 다시
   * 덮어써진다 — 즉 이건 "이 문제만 예외적으로 다른 과목/연도로 표시하고
   * 싶을 때" 쓰는 문제별 오버라이드이지, 문제지 자체의 메타데이터를 바꾸는
   * 기능이 아니다(문제지 자체를 바꾸려면 "문제지 보기"의 이름수정을 쓴다).
   */
  async function applyBulkMeta() {
    const targets = pendingBulkMetaTargets;
    if (!targets || !targets.length) { el('#bulkMetaModal').classList.add('hidden'); return; }

    const yearVal = el('#bulkMetaYear').value.trim();
    const examTypeVal = el('#bulkMetaExamType').value.trim();
    const subjectVal = el('#bulkMetaSubject').value.trim();
    const tagsRaw = el('#bulkMetaTags').value.trim();
    const tagMode = el('#bulkMetaModal').querySelector('input[name="bulkMetaTagMode"]:checked').value; // 'add' | 'replace'
    const newTags = tagsRaw ? tagsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];

    if (!yearVal && !examTypeVal && !subjectVal && newTags.length === 0) {
      alert('변경할 값을 하나 이상 입력해주세요.');
      return;
    }

    const changes = [];
    if (yearVal) changes.push(`연도 → ${yearVal}`);
    if (examTypeVal) changes.push(`시험유형 → ${examTypeVal}`);
    if (subjectVal) changes.push(`과목 → ${subjectVal}`);
    if (newTags.length) changes.push(`태그 ${tagMode === 'replace' ? '전체 교체' : '추가'} → ${newTags.join(', ')}`);
    if (!confirm(`선택한 문제 ${targets.length}개에 다음을 적용할까요?\n\n${changes.join('\n')}`)) return;

    for (const t of targets) {
      const q = await DB.getQuestion(t.id);
      if (!q) continue;
      if (yearVal) q.examYear = yearVal;
      if (examTypeVal) q.examType = examTypeVal;
      if (subjectVal) q.subject = subjectVal;
      if (newTags.length) {
        if (tagMode === 'replace') {
          q.tags = newTags.slice();
        } else {
          q.tags = Array.from(new Set([...(q.tags || []), ...newTags]));
        }
      }
      await DB.updateQuestion(q);
    }

    pendingBulkMetaTargets = [];
    el('#bulkMetaModal').classList.add('hidden');
    await refresh();
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ==================== 태그 관리 모달 ====================
  // fullList(전체 문제) 기준으로 동작한다(라이브러리 메인 필터와는 독립적인 별도 스코프).
  // 시험유형/과목 체크박스로 문제 범위를 좁히고, 그 범위 안에서 실제 쓰이는 태그+개수를
  // 계산해서 보여준다. 이름변경/삭제는 항상 "현재 이 모달의 필터에 걸린 문제들"에만 적용된다.

  function openTagManager() {
    renderTagManagerFilters();
    renderTagManagerList();
    el('#tagManagerModal').classList.remove('hidden');
  }

  /** 시험유형/과목 체크박스 목록을 fullList 기준 고유값으로 채운다(이미 체크된 값은 유지) */
  function renderTagManagerFilters() {
    const examTypeValues = Array.from(new Set(fullList.map((q) => q.examType))).filter(Boolean).sort();
    const subjectValues = Array.from(new Set(fullList.map((q) => q.subject))).filter(Boolean).sort();

    const buildList = (containerSel, values) => {
      const container = el(containerSel);
      const prevChecked = new Set(elAll('input[type="checkbox"]', container).filter((c) => c.checked).map((c) => c.value));
      if (!values.length) {
        container.innerHTML = '<div class="emptyHint">값 없음</div>';
        return;
      }
      container.innerHTML = values.map((v) => `
        <label><input type="checkbox" value="${escapeHtml(v)}" ${prevChecked.has(v) ? 'checked' : ''}> ${escapeHtml(v)}</label>
      `).join('');
      elAll('input[type="checkbox"]', container).forEach((c) => c.addEventListener('change', renderTagManagerList));
    };
    buildList('#tagMgrExamTypeList', examTypeValues);
    buildList('#tagMgrSubjectList', subjectValues);
  }

  /** 현재 체크된 시험유형/과목(다중 선택, 각 항목 안에서는 OR / 항목 간에는 AND)에 맞는 문제들만 반환 */
  function tagMgrFilteredQuestions() {
    const checkedExamTypes = elAll('#tagMgrExamTypeList input[type="checkbox"]:checked').map((c) => c.value);
    const checkedSubjects = elAll('#tagMgrSubjectList input[type="checkbox"]:checked').map((c) => c.value);
    return fullList.filter((q) => {
      if (checkedExamTypes.length && !checkedExamTypes.includes(q.examType)) return false;
      if (checkedSubjects.length && !checkedSubjects.includes(q.subject)) return false;
      return true;
    });
  }

  function renderTagManagerList() {
    const scoped = tagMgrFilteredQuestions();
    const search = el('#tagMgrSearch').value.trim().toLowerCase();

    const counts = new Map(); // tag -> count
    scoped.forEach((q) => (q.tags || []).forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));

    let tags = Array.from(counts.keys()).sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b));
    if (search) tags = tags.filter((t) => t.toLowerCase().includes(search));

    el('#tagMgrSummary').textContent = `범위 내 문제 ${scoped.length}개 · 태그 ${tags.length}종`;

    const listEl = el('#tagMgrList');
    if (!tags.length) {
      listEl.innerHTML = '<div class="tagMgrEmpty">해당 범위에 태그가 없습니다.</div>';
      return;
    }
    listEl.innerHTML = tags.map((t) => `
      <div class="tagMgrRow" data-tag="${escapeHtml(t)}">
        <span class="tagMgrRowName">${escapeHtml(t)}</span>
        <span class="tagMgrRowCount">${counts.get(t)}개 문제</span>
        <div class="tagMgrRowActions">
          <button type="button" class="btnSecondary tagMgrRenameBtn">이름변경</button>
          <button type="button" class="btnDanger tagMgrDeleteBtn">삭제</button>
        </div>
      </div>
    `).join('');

    elAll('.tagMgrRenameBtn', listEl).forEach((btn) => {
      btn.addEventListener('click', () => beginTagRename(btn.closest('.tagMgrRow')));
    });
    elAll('.tagMgrDeleteBtn', listEl).forEach((btn) => {
      btn.addEventListener('click', () => tagMgrDeleteTag(btn.closest('.tagMgrRow').dataset.tag));
    });
  }

  /** 태그 행을 "이름변경" 모드로 바꿔 인라인 입력창 + 저장/취소 버튼을 보여준다 */
  function beginTagRename(row) {
    if (!row) return;
    const oldTag = row.dataset.tag;
    row.innerHTML = `
      <input type="text" class="tagMgrRenameInput" value="${escapeHtml(oldTag)}">
      <div class="tagMgrRowActions">
        <button type="button" class="btnGhost tagMgrRenameCancelBtn">취소</button>
        <button type="button" class="btnPrimary tagMgrRenameSaveBtn">저장</button>
      </div>
    `;
    const input = row.querySelector('.tagMgrRenameInput');
    input.focus();
    input.select();
    const commit = () => tagMgrRenameTag(oldTag, input.value.trim());
    row.querySelector('.tagMgrRenameSaveBtn').addEventListener('click', commit);
    row.querySelector('.tagMgrRenameCancelBtn').addEventListener('click', renderTagManagerList);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); renderTagManagerList(); }
    });
  }

  /**
   * 현재 태그관리 필터 범위 안의 문제들에 대해서만 oldTag → newTag로 이름을 바꾼다.
   * newTag가 그 문제에 이미 있는 다른 태그와 같아지면 자연스럽게 병합(중복 제거)된다.
   * newTag가 빈 값이면 사실상 삭제와 동일하게 처리(안내 후 진행).
   */
  async function tagMgrRenameTag(oldTag, newTag) {
    if (newTag === oldTag) { renderTagManagerList(); return; }
    if (!newTag) {
      if (!confirm(`새 이름이 비어있습니다. "${oldTag}" 태그를 삭제할까요?`)) { renderTagManagerList(); return; }
      await tagMgrDeleteTag(oldTag);
      return;
    }
    const scoped = tagMgrFilteredQuestions().filter((q) => (q.tags || []).includes(oldTag));
    if (!scoped.length) { renderTagManagerList(); return; }
    if (!confirm(`"${oldTag}" → "${newTag}"(으)로 ${scoped.length}개 문제에서 이름을 바꿀까요?`)) { renderTagManagerList(); return; }
    for (const item of scoped) {
      const q = await DB.getQuestion(item.id);
      if (!q) continue;
      q.tags = Array.from(new Set((q.tags || []).map((t) => (t === oldTag ? newTag : t))));
      await DB.updateQuestion(q);
    }
    await refresh();
    renderTagManagerFilters();
    renderTagManagerList();
  }

  /** 현재 태그관리 필터 범위 안의 문제들에서만 해당 태그를 제거한다(문제 자체는 삭제하지 않음) */
  async function tagMgrDeleteTag(tag) {
    const scoped = tagMgrFilteredQuestions().filter((q) => (q.tags || []).includes(tag));
    if (!scoped.length) return;
    if (!confirm(`"${tag}" 태그를 ${scoped.length}개 문제에서 제거할까요? (문제 자체는 삭제되지 않습니다)`)) return;
    for (const item of scoped) {
      const q = await DB.getQuestion(item.id);
      if (!q) continue;
      q.tags = (q.tags || []).filter((t) => t !== tag);
      await DB.updateQuestion(q);
    }
    await refresh();
    renderTagManagerFilters();
    renderTagManagerList();
  }

  return { init, refresh, onShow };
})();

window.LibraryUI = LibraryUI;
