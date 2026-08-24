/* solve.js — "문제풀이" 탭: 라이브러리에서 독립된 모바일 최적화 문제풀이 기능.
 *
 * 흐름:
 *  1) 탭 진입 시 이어서 풀던 세션(DB meta 'solveSession')이 있으면 이어서 풀기 카드를 보여주고,
 *     없으면 곧바로 "문제지 만들기" 설정 화면(시험별/과목별/연도별 + 전체/직접고르기/랜덤 n개)을 보여준다.
 *  2) 설정 완료 → 풀스크린 모바일 뷰어(#solveOverlay)에서 한 문제씩 풀이.
 *     하단 진행바(이전/정답보기/다음/N of M), 좌측 스와이프 드로어(문제 목록), 채점 버튼.
 *  3) 채점 → 결과/분석 화면(총점, 과목별 정답률, 문제별 결과 목록 → 탭하면 그 문제 리뷰).
 *
 * 세션은 문제 id 배열 + 사용자가 고른 답만 IndexedDB(meta 스토어)에 저장해 가볍게 유지하고,
 * 실제 문제/이미지 객체는 매번 새로 불러온다(라이브러리 데이터가 진실의 원천).
 */

const SolveUI = (() => {
  const SESSION_KEY = 'solveSession';
  const TEXT_MODE_KEY = 'solveTextModePref';

  let allQuestions = [];      // 설정 화면 필터링용 전체 문제 캐시
  let matched = [];           // 현재 필터 조건에 맞는 문제들
  let pickedIds = new Set();  // "직접 고르기" 모드에서 선택된 문제 id

  let session = null;         // { id, questionIds, index, userAnswers, revealed, submitted, filterLabel, createdAt, updatedAt }
  let questions = [];         // session.questionIds에 대응하는 실제 문제 객체 배열(풀이 중 캐시)
  let urlCache = new Map();   // qid -> [objectURL, ...]
  let choicesCache = new Map(); // qid -> choices[] (텍스트 보기용, hasTextChoices인 문제만 채워짐)
  let textMode = false;       // 이미지 대신 텍스트로 풀기 — 설정을 기억해뒀다가 다음 진입 때도 이어서 씀
  let drawerOpen = false;
  let touchState = null;      // 스와이프 제스처 추적

  // ---- 문제별 체류 시간 타이머 ----
  // "지금 보고 있는 문제에 얼마나 머물렀는지"만 보여주는 단순 스톱워치. 다른
  // 문제로 이동하거나, 채점하거나, 나갔다 다시 들어오면 그때마다 0초로
  // 초기화된다(문제 간 시간을 누적하지 않음 — 순수하게 "지금 이 문제"용).
  let timerInterval = null;
  let timerQid = null;
  let timerStartTs = 0;

  function el(sel, root = document) { return root.querySelector(sel); }
  function elAll(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ==================== 초기화 ====================

  function init() {
    // ---- 설정 화면 ----
    el('#solveExamTypeFilter').addEventListener('change', onFilterChange);
    el('#solveSubjectFilter').addEventListener('change', onFilterChange);
    el('#solveYearFilter').addEventListener('change', onFilterChange);
    elAll('input[name="solveMode"]').forEach((r) => r.addEventListener('change', onModeChange));
    el('#solveRandomCount').addEventListener('input', updateStartStatus);
    el('#solveStartBtn').addEventListener('click', onStartClick);

    // ---- 풀이 화면 ----
    el('#solveExitBtn').addEventListener('click', onExitClick);
    el('#solveGradeBtn').addEventListener('click', onGradeBtnClick);
    el('#solvePrevBtn').addEventListener('click', () => goTo(session.index - 1));
    el('#solveNextBtn').addEventListener('click', () => goTo(session.index + 1));
    el('#solveRevealBtn').addEventListener('click', onRevealClick);
    el('#solveChoiceRow').addEventListener('click', onChoiceClick);
    el('#solveTextToggle').addEventListener('click', onTextToggleClick);

    // ---- 드로어(문제 목록) ----
    el('#solveListBtn').addEventListener('click', openDrawer);
    el('#solveDrawerClose').addEventListener('click', closeDrawer);
    el('#solveDrawerBackdrop').addEventListener('click', closeDrawer);
    el('#solveDrawerGrid').addEventListener('click', onDrawerGridClick);
    el('#solveDrawerNewBtn').addEventListener('click', onResumeDiscard);

    // ---- 결과 화면 ----
    el('#solveResultCloseBtn').addEventListener('click', onResultCloseClick);
    el('#solveRetryWrongBtn').addEventListener('click', onRetryWrongClick);
    el('#solveNewBtn').addEventListener('click', onNewSolveClick);
    el('#solveResultList').addEventListener('click', onResultListClick);

    // ---- 스와이프 제스처(왼쪽 가장자리에서 오른쪽으로 밀면 드로어 열림, 드로어에서 왼쪽으로 밀면 닫힘) ----
    const box = el('.solveBox', el('#solveOverlay'));
    box.addEventListener('touchstart', onTouchStart, { passive: true });
    box.addEventListener('touchmove', onTouchMove, { passive: true });
    box.addEventListener('touchend', onTouchEnd, { passive: true });
  }

  // ==================== 탭 진입 ====================

  /** 탭에 진입할 때마다 호출: 풀던 문제가 있으면 설정 화면을 거치지 않고 곧장 이어서 풀이로 들어간다. */
  async function onShow() {
    allQuestions = await DB.getAllQuestions();
    await refreshSetupScreen();
    textMode = !!(await DB.getMeta(TEXT_MODE_KEY));

    const persisted = await DB.getMeta(SESSION_KEY);
    if (persisted && persisted.questionIds && persisted.questionIds.length && !persisted.submitted) {
      session = persisted;
      await hydrateSessionQuestions();
      if (questions.length) { openOverlay(); return; }
      // 문제가 이미 삭제된 등 이어받을 게 없으면 세션을 정리하고 설정 화면으로.
      await DB.setMeta(SESSION_KEY, null);
      session = null;
    }
  }

  /** 설정 화면(필터/매칭 개수)만 새로고침 — 풀이 화면에서 그냥 나가기(exit) 할 때 쓰임.
   * (onShow와 달리 "이어서 풀기 자동 진입" 체크를 하지 않는다 — 방금 나온 세션을
   * 곧바로 다시 열어버리는 걸 막기 위함.) */
  async function refreshSetupScreen() {
    populateFilterOptions();
    pickedIds.clear();
    applyMatch();
  }

  // 풀이 화면 안에서 "새 문제풀이 만들기"로 현재 세션을 버릴 때 사용
  async function onResumeDiscard() {
    if (session && !confirm('현재 풀고 있는 문제풀이를 그만두고 새로 만들까요?')) return;
    await DB.setMeta(SESSION_KEY, null);
    session = null;
    questions = [];
    revokeAllUrls();
    el('#solveOverlay').classList.add('hidden');
    onShow();
  }

  // ==================== 설정 화면: 필터/모드 ====================

  function populateFilterOptions() {
    const examTypeValues = uniqSorted(allQuestions.map((q) => q.examType));
    const subjectValues = uniqSorted(allQuestions.map((q) => q.subject));
    const yearValues = uniqSorted(allQuestions.map((q) => q.examYear));
    fillSelect('#solveExamTypeFilter', examTypeValues, '전체');
    fillSelect('#solveSubjectFilter', subjectValues, '전체');
    fillSelect('#solveYearFilter', yearValues.map((y) => ({ value: y, label: y + '년' })), '전체');
  }

  function uniqSorted(list) {
    return Array.from(new Set(list.filter(Boolean))).sort();
  }

  function fillSelect(sel, values, allLabel) {
    const node = el(sel);
    const cur = node.value;
    const opts = values.map((v) => (typeof v === 'object' ? v : { value: v, label: v }));
    node.innerHTML = `<option value="">${allLabel}</option>` +
      opts.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
    if (opts.some((o) => o.value === cur)) node.value = cur;
  }

  function onFilterChange() {
    pickedIds.clear();
    applyMatch();
  }

  function onModeChange() {
    const mode = currentMode();
    el('#solvePickList').classList.toggle('hidden', mode !== 'pick');
    if (mode === 'pick') renderPickList();
    updateStartStatus();
  }

  function currentMode() {
    const checked = el('input[name="solveMode"]:checked');
    return checked ? checked.value : 'all';
  }

  function applyMatch() {
    const examType = el('#solveExamTypeFilter').value;
    const subject = el('#solveSubjectFilter').value;
    const year = el('#solveYearFilter').value;
    matched = allQuestions.filter((q) => {
      if (examType && q.examType !== examType) return false;
      if (subject && q.subject !== subject) return false;
      if (year && q.examYear !== year) return false;
      return true;
    }).sort((a, b) => (a.code || '').localeCompare(b.code || ''));
    el('#solveMatchCount').textContent = matched.length;
    el('#solveRandomCount').max = Math.max(1, matched.length);
    if (currentMode() === 'pick') renderPickList();
    updateStartStatus();
  }

  function renderPickList() {
    const wrap = el('#solvePickList');
    const LIMIT = 400;
    const shown = matched.slice(0, LIMIT);
    wrap.innerHTML = shown.map((q) => `
      <label class="solvePickRow">
        <input type="checkbox" data-id="${q.id}" ${pickedIds.has(q.id) ? 'checked' : ''}>
        <span class="solvePickCode">${escapeHtml(q.code || q.id)}</span>
        <span class="solvePickTitle">${escapeHtml(q.examTitle || '')} · ${q.qnum ?? ''}번</span>
      </label>`).join('') +
      (matched.length > LIMIT ? `<div class="solvePickMoreNote">처음 ${LIMIT}개까지만 표시됩니다. 필터로 더 좁혀보세요(총 ${matched.length}개 매칭됨).</div>` : '');
    elAll('input[type=checkbox]', wrap).forEach((chk) => {
      chk.addEventListener('change', () => {
        if (chk.checked) pickedIds.add(chk.dataset.id);
        else pickedIds.delete(chk.dataset.id);
        el('#solvePickCount').textContent = pickedIds.size;
        updateStartStatus();
      });
    });
    el('#solvePickCount').textContent = pickedIds.size;
  }

  function updateStartStatus() {
    const mode = currentMode();
    let n = matched.length;
    if (mode === 'random') n = Math.min(matched.length, Math.max(1, parseInt(el('#solveRandomCount').value, 10) || 0));
    if (mode === 'pick') n = pickedIds.size;
    el('#solveSetupStatus').textContent = matched.length === 0
      ? '조건에 맞는 문제가 없습니다.'
      : `이 조건으로 ${n}문항을 풀게 됩니다.`;
  }

  function buildFilterLabel() {
    const parts = [el('#solveExamTypeFilter').value, el('#solveSubjectFilter').value, el('#solveYearFilter').value ? el('#solveYearFilter').value + '년' : ''];
    return parts.filter(Boolean).join(' · ') || '전체 문제';
  }

  async function onStartClick() {
    const mode = currentMode();
    let ids = [];
    if (mode === 'all') {
      ids = matched.map((q) => q.id);
    } else if (mode === 'random') {
      const n = Math.min(matched.length, Math.max(1, parseInt(el('#solveRandomCount').value, 10) || 0));
      ids = shuffle(matched).slice(0, n).map((q) => q.id);
    } else if (mode === 'pick') {
      ids = matched.filter((q) => pickedIds.has(q.id)).map((q) => q.id);
    }
    if (!ids.length) { alert('풀 문제가 없습니다. 조건을 확인해주세요.'); return; }
    await createSession(ids, buildFilterLabel());
    await hydrateSessionQuestions();
    openOverlay();
  }

  /** 라이브러리에서 선택한 문제들로 곧바로 문제풀이를 시작(설정 화면 건너뜀) */
  async function startWithQuestions(list) {
    if (!list || !list.length) return;
    App.switchTab('solve');
    await createSession(list.map((q) => q.id), `선택한 문제 ${list.length}개`);
    questions = list.slice();
    session.questionIds = questions.map((q) => q.id);
    await persistSession();
    openOverlay();
  }

  async function createSession(ids, filterLabel) {
    session = {
      id: DB.uid('solve'),
      questionIds: ids,
      index: 0,
      userAnswers: {},
      revealed: {},
      submitted: false,
      filterLabel,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await persistSession();
  }

  async function persistSession() {
    if (!session) return;
    session.updatedAt = Date.now();
    const slim = {
      id: session.id, questionIds: session.questionIds, index: session.index,
      userAnswers: session.userAnswers, revealed: session.revealed,
      submitted: session.submitted,
      filterLabel: session.filterLabel, createdAt: session.createdAt, updatedAt: session.updatedAt,
    };
    await DB.setMeta(SESSION_KEY, session.submitted ? null : slim);
  }

  async function hydrateSessionQuestions() {
    const fetched = await Promise.all(session.questionIds.map((id) => DB.getQuestion(id)));
    questions = fetched.filter(Boolean);
    session.questionIds = questions.map((q) => q.id);
    if (session.index >= questions.length) session.index = Math.max(0, questions.length - 1);
  }

  // ==================== 풀이 뷰어 ====================

  function openOverlay() {
    el('#solveOverlay').classList.remove('hidden');
    el('#solveResult').classList.add('hidden');
    el('#solvePlay').classList.remove('hidden');
    closeDrawer();
    buildDrawerGrid();
    render();
  }

  function onExitClick() {
    // 세션은 이미 답을 바꿀 때마다 저장돼 있으므로 그냥 화면만 닫는다(다음에 이 탭에
    // 들어오면 자동으로 이어서 풀이가 열림). 여기서 onShow()를 다시 부르면 방금 닫은
    // 화면이 곧바로 재오픈되어버리므로 설정 화면 새로고침만 한다.
    stopTimer(); // 나갔다 다시 들어오면 타이머는 항상 0초부터 — 인터벌만 정리하면 충분(누적 저장 없음)
    revokeAllUrls();
    el('#solveOverlay').classList.add('hidden');
    refreshSetupScreen();
  }

  async function goTo(idx) {
    if (idx < 0 || idx >= questions.length) return;
    session.index = idx;
    await persistSession();
    render();
  }

  function stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    timerQid = null;
  }

  function startTimer(qid) {
    timerQid = qid;
    timerStartTs = Date.now();
    updateTimerDisplay();
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(updateTimerDisplay, 1000);
  }

  /** render()가 매번 호출돼도(답 선택, 텍스트 토글 등으로 같은 문제를 다시 그릴 때) 타이머가
   * 리셋되지 않게 하되, 문제가 실제로 바뀌었을 때는 무조건 0초부터 다시 시작한다(요청대로
   * 문제 간 시간을 이어서 누적하지 않음). */
  function ensureTimerFor(qid) {
    if (timerQid === qid && timerInterval) return;
    startTimer(qid);
  }

  function updateTimerDisplay() {
    if (!timerQid) return;
    const totalSec = Math.floor((Date.now() - timerStartTs) / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    const label = `⏱ ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    const timerEl = el('#solveTimer');
    if (timerEl) timerEl.textContent = label;
  }

  async function render() {
    const q = questions[session.index];
    if (!q) return;

    ensureTimerFor(q.id);

    el('#solveMetaCode').textContent = q.code || q.examTitle || '';
    el('#solveMetaSub').textContent = `${q.examTitle || ''} · ${q.subject || ''} · ${q.qnum ?? ''}번`;

    if (!urlCache.has(q.id)) urlCache.set(q.id, await DB.getImageURLs(q));

    el('#solveTextToggle').classList.toggle('hidden', !q.hasTextChoices);
    // 텍스트 모드를 켜뒀어도 이 문제가 텍스트 선지를 못 뽑아낸 문제라면(hasTextChoices=false)
    // 이미지로 자동 대체해서 보여준다 — 토글 자체(preference)는 그대로 켜진 채 유지되므로
    // 다음 문제로 넘어가면 다시 텍스트로 보인다.
    const showText = textMode && q.hasTextChoices;
    el('#solveImageArea').classList.toggle('hidden', showText);
    el('#solveTextArea').classList.toggle('hidden', !showText);

    if (showText) {
      if (!choicesCache.has(q.id)) {
        const list = await DB.getChoicesByQuestion(q.id);
        list.sort((a, b) => (a.markerIndex || 0) - (b.markerIndex || 0));
        choicesCache.set(q.id, list);
      }
      renderTextArea(q, choicesCache.get(q.id));
    } else {
      const imgArea = el('#solveImageArea');
      imgArea.innerHTML = urlCache.get(q.id).map((u) => `<img src="${u}" alt="문제 이미지">`).join('');
      imgArea.classList.toggle('layout-row', q.partsLayout === 'row');
    }

    renderChoices();
    renderAnswerPanel();
    updateBottomBar();
    updateDrawerHighlight();
    el('#solveGradeBtn').textContent = session.submitted ? '결과' : '채점';
  }

  /** 이미지 대신 설문(발문)+선지를 텍스트로 보여준다. 답 선택 자체는 기존 #solveChoiceRow
   * (①②③④⑤ 버튼)를 그대로 쓴다 — 여긴 "읽기"만 담당해서 답 선택 로직을 중복 구현하지 않는다.
   * 원문자 마커는 화면에서 잘 안 보일 수 있어 (1)(2)(3) 식으로 바꿔 표시한다(표시용 변환만,
   * 저장된 marker/code 값 자체는 그대로 — PDFAnalyze.prettifyMarkers 참고). */
  function renderTextArea(q, choices) {
    const stem = escapeHtml(PDFAnalyze.prettifyMarkers(q.stemFullText) || '(발문 텍스트를 인식하지 못했습니다)').replace(/\n/g, '<br>');
    const choicesHtml = (choices || []).map((c) => `
      <div class="solveTextChoice">
        <span class="solveTextChoiceMarker">${escapeHtml(PDFAnalyze.markerToPlain(c.marker))}</span>
        <span class="solveTextChoiceBody">${escapeHtml(PDFAnalyze.prettifyMarkers(c.text))}</span>
      </div>`).join('');
    const area = el('#solveTextArea');
    area.innerHTML = `
      ${TextViewPrefs.controlsHtml()}
      <div class="tvReadingArea">
        <div class="solveTextStem">${stem}</div>
        <div class="solveTextChoices">${choicesHtml}</div>
      </div>
    `;
    TextViewPrefs.applyTo(area.querySelector('.tvReadingArea'));
    TextViewPrefs.wireControls(area, () => TextViewPrefs.applyTo(area.querySelector('.tvReadingArea')));
  }

  function onTextToggleClick() {
    textMode = !textMode;
    DB.setMeta(TEXT_MODE_KEY, textMode);
    render();
  }

  function renderChoices() {
    const q = questions[session.index];
    const chosen = session.userAnswers[q.id];
    const showResolved = session.submitted || session.revealed[q.id];
    const labels = ['(1)', '(2)', '(3)', '(4)', '(5)'];
    el('#solveChoiceRow').innerHTML = ['1', '2', '3', '4', '5'].map((v, i) => {
      let cls = 'solveChoiceBtn';
      if (showResolved && q.answer) {
        if (v === String(q.answer)) cls += ' correctChoice';
        else if (v === chosen) cls += ' wrongChoice';
      } else if (chosen === v) {
        cls += ' selected';
      }
      return `<button class="${cls}" data-value="${v}" ${showResolved ? 'disabled' : ''}>${labels[i]}</button>`;
    }).join('');
  }

  function onChoiceClick(e) {
    const btn = e.target.closest('.solveChoiceBtn');
    if (!btn || btn.disabled) return;
    const q = questions[session.index];
    if (session.submitted) return;
    session.userAnswers[q.id] = btn.dataset.value;
    persistSession();
    render();
  }

  function onRevealClick() {
    const q = questions[session.index];
    session.revealed[q.id] = !session.revealed[q.id];
    persistSession();
    render();
  }

  function renderAnswerPanel() {
    const q = questions[session.index];
    const panel = el('#solveAnswerPanel');
    const show = session.submitted || session.revealed[q.id];
    panel.classList.toggle('hidden', !show);
    if (!show) { panel.innerHTML = ''; return; }
    if (!q.answer) {
      panel.innerHTML = `<div class="solveAnswerLine">이 문제에는 등록된 정답이 없습니다.</div>`;
      return;
    }
    const chosen = session.userAnswers[q.id];
    const correct = chosen === String(q.answer);
    const labels = ['(1)', '(2)', '(3)', '(4)', '(5)'];
    const answerLabel = labels[Number(q.answer) - 1] || q.answer;
    let line;
    if (!chosen) line = `<span class="solveAnswerLine">정답: ${answerLabel}</span>`;
    else line = `<span class="solveAnswerLine ${correct ? 'ans-correct' : 'ans-wrong'}">${correct ? '정답입니다! ' : '오답입니다. '}정답: ${answerLabel}</span>`;
    panel.innerHTML = line + (q.explanation ? `<div class="solveAnswerExplain">${escapeHtml(q.explanation).replace(/\n/g, '<br>')}</div>` : '');
  }

  function updateBottomBar() {
    const total = questions.length;
    el('#solvePrevBtn').disabled = session.index === 0;
    el('#solveNextBtn').disabled = session.index === total - 1;
    el('#solveProgressLabel').textContent = `${session.index + 1} / ${total}`;
    el('#solveProgressBarFill').style.width = `${((session.index + 1) / total) * 100}%`;
  }

  // ==================== 문제 목록 드로어(스와이프) ====================

  function buildDrawerGrid() {
    const grid = el('#solveDrawerGrid');
    grid.innerHTML = questions.map((q, i) => `<button class="solveDrawerBtn" data-idx="${i}">${i + 1}</button>`).join('');
  }

  function updateDrawerHighlight() {
    elAll('.solveDrawerBtn').forEach((btn) => {
      const i = Number(btn.dataset.idx);
      const q = questions[i];
      btn.classList.toggle('current', i === session.index);
      btn.classList.remove('answered', 'correct', 'wrong');
      const chosen = session.userAnswers[q.id];
      if (session.submitted && q.answer) {
        btn.classList.add(chosen === String(q.answer) ? 'correct' : (chosen ? 'wrong' : 'answered'));
      } else if (chosen) {
        btn.classList.add('answered');
      }
    });
  }

  function onDrawerGridClick(e) {
    const btn = e.target.closest('.solveDrawerBtn');
    if (!btn) return;
    goTo(Number(btn.dataset.idx));
    closeDrawer();
  }

  function openDrawer() {
    drawerOpen = true;
    el('#solveDrawer').classList.add('open');
    el('#solveDrawerBackdrop').classList.remove('hidden');
  }
  function closeDrawer() {
    drawerOpen = false;
    el('#solveDrawer').classList.remove('open');
    el('#solveDrawerBackdrop').classList.add('hidden');
  }

  function onTouchStart(e) {
    const t = e.touches[0];
    touchState = { startX: t.clientX, startY: t.clientY, moved: false };
  }
  function onTouchMove(e) {
    if (!touchState) return;
    const t = e.touches[0];
    const dx = t.clientX - touchState.startX;
    const dy = t.clientY - touchState.startY;
    if (Math.abs(dy) > Math.abs(dx)) return; // 세로 스크롤과 헷갈리지 않도록
    touchState.moved = true;
    if (!drawerOpen && touchState.startX < 28 && dx > 60) openDrawer();
    if (drawerOpen && dx < -60) closeDrawer();
  }
  function onTouchEnd() { touchState = null; }

  // ==================== 채점 / 결과 ====================

  function onGradeBtnClick() {
    if (session.submitted) { showResultScreen(); return; }
    gradeAndShow();
  }

  async function gradeAndShow() {
    if (!confirm('채점할까요? 채점 후에는 답을 바꿀 수 없습니다.')) return;
    session.submitted = true;
    await persistSession(); // submitted=true라 내부적으로 세션을 지움(이어풀기 목록에서 제거)
    showResultScreen();
  }

  function showResultScreen() {
    stopTimer();
    const gradable = questions.filter((q) => q.answer);
    let correct = 0;
    gradable.forEach((q) => { if (session.userAnswers[q.id] === String(q.answer)) correct++; });

    el('#solvePlay').classList.add('hidden');
    el('#solveResult').classList.remove('hidden');

    const pct = gradable.length ? Math.round((correct / gradable.length) * 100) : 0;
    el('#solveScoreText').textContent = gradable.length ? `${pct}점` : '-';
    el('#solveScoreLine').textContent = gradable.length
      ? `채점 가능 ${gradable.length}문제 중 ${correct}개 정답`
      : '정답이 등록된 문제가 없어 채점할 수 없습니다.';

    // 과목별 정답률
    const bySubject = new Map();
    gradable.forEach((q) => {
      const key = q.subject || '(과목 없음)';
      if (!bySubject.has(key)) bySubject.set(key, { total: 0, correct: 0 });
      const s = bySubject.get(key);
      s.total++;
      if (session.userAnswers[q.id] === String(q.answer)) s.correct++;
    });
    const breakdown = el('#solveSubjectBreakdown');
    if (bySubject.size > 1) {
      breakdown.innerHTML = Array.from(bySubject.entries()).map(([name, s]) => {
        const p = Math.round((s.correct / s.total) * 100);
        return `<div class="solveSubjectRow">
          <span class="solveSubjectName">${escapeHtml(name)}</span>
          <div class="solveSubjectBarBg"><div class="solveSubjectBarFill" style="width:${p}%"></div></div>
          <span class="solveSubjectPct">${s.correct}/${s.total}</span>
        </div>`;
      }).join('');
    } else {
      breakdown.innerHTML = '';
    }

    const list = el('#solveResultList');
    list.innerHTML = questions.map((q, i) => {
      const chosen = session.userAnswers[q.id] || '-';
      const isGradable = !!q.answer;
      const isCorrect = isGradable && chosen === String(q.answer);
      const cls = isGradable ? (isCorrect ? 'res-correct' : 'res-wrong') : 'res-nograde';
      return `<div class="solveResultRow ${cls}" data-idx="${i}">
        <span>${i + 1}. ${escapeHtml(q.code || q.examTitle)} ${q.qnum ?? ''}번</span>
        <span>${chosen} ${isGradable ? '/ 정답 ' + q.answer : '(미등록)'}</span>
      </div>`;
    }).join('');

    buildDrawerGrid();
  }

  function onResultCloseClick() {
    revokeAllUrls();
    el('#solveOverlay').classList.add('hidden');
    onShow();
  }

  function onResultListClick(e) {
    const row = e.target.closest('.solveResultRow');
    if (!row) return;
    el('#solveResult').classList.add('hidden');
    el('#solvePlay').classList.remove('hidden');
    goTo(Number(row.dataset.idx));
  }

  async function onRetryWrongClick() {
    const wrong = questions.filter((q) => q.answer && session.userAnswers[q.id] && session.userAnswers[q.id] !== String(q.answer));
    if (!wrong.length) { alert('틀린 문제가 없습니다.'); return; }
    await createSession(wrong.map((q) => q.id), '틀린 문제만 다시 풀기');
    questions = wrong.slice();
    session.questionIds = questions.map((q) => q.id);
    await persistSession();
    openOverlay();
  }

  function onNewSolveClick() {
    revokeAllUrls();
    session = null;
    questions = [];
    el('#solveOverlay').classList.add('hidden');
    App.switchTab('solve');
    onShow();
  }

  function revokeAllUrls() {
    urlCache.forEach((arr) => arr.forEach((u) => URL.revokeObjectURL(u)));
    urlCache.clear();
    choicesCache.clear();
  }

  return { init, onShow, startWithQuestions };
})();

window.SolveUI = SolveUI;
