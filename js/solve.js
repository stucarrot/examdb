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
  const TIMER_MODE_KEY = 'solveTimerModePref';

  let allQuestions = [];      // 설정 화면 필터링용 전체 문제 캐시
  let matched = [];           // 현재 필터 조건에 맞는 문제들
  let pickedIds = new Set();  // "직접 고르기" 모드에서 선택된 문제 id

  let session = null;         // { id, questionIds, index, userAnswers, revealed, submitted, filterLabel, createdAt, updatedAt }
  let questions = [];         // session.questionIds에 대응하는 실제 문제 객체 배열(풀이 중 캐시)
  let urlCache = new Map();   // qid -> [objectURL, ...]
  let choicesCache = new Map(); // qid -> choices[] (텍스트 보기용, hasTextChoices인 문제만 채워짐)
  let textMode = false;       // 이미지 대신 텍스트로 풀기 — 설정을 기억해뒀다가 다음 진입 때도 이어서 씀
  // 텍스트로 풀기 화면의 글자크기/테마 설정 패널 — 문제 공간을 최대한 확보하기 위해
  // 기본은 접힌 상태(true)로 시작한다. 사용자가 한 번 펼치면 문제를 넘기거나 드로어를
  // 열어도 그 상태 그대로 유지되고(module-level 변수라 브라우저 새로고침 전까지는 안 잊음),
  // 다시 접고 싶으면 토글 버튼을 눌러 접으면 된다.
  let solveTvCollapsed = true;
  let drawerOpen = false;
  let touchState = null;      // 스와이프 제스처 추적

  // ---- 문제별 체류 시간 타이머 ----
  // 실제 경과 시간 누적(session.timeSpent[qid])은 항상 배경에서 계속 이뤄지고,
  // 화면에 "무엇을 보여줄지"만 timerMode로 토글한다:
  //  - 'perVisit'(기본): 지금 이 문제에 "방금 들어온 뒤로" 흐른 시간만(다른 문제로
  //    이동/채점/나갔다 재진입하면 0초로 다시 시작 — 예전 요청대로).
  //  - 'cumulative': 이번 문제풀이 세션에서 이 문제에 "지금까지 머문 총 시간"
  //    (여러 번 들락날락한 시간을 다 더한 값 + 지금 보는 중인 시간).
  // 타이머 배지(#solveTimer)를 클릭하면 두 모드를 토글(onTimerToggleClick).
  let timerMode = 'perVisit';
  let timerInterval = null;
  let timerQid = null;
  let timerStartTs = 0;

  // render()가 마지막으로 그린 문제 id. 답 선택/정답보기 토글처럼 "같은 문제를 다시
  // 그리는" 호출인지, goTo()처럼 "실제로 다른 문제로 이동하는" 호출인지 구분하는 데 쓴다
  // (같은 문제면 스크롤 위치를 유지, 문제가 바뀌면 스크롤을 맨 위로 초기화).
  let renderedQid = null;

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
    el('#solveExplainBtn').addEventListener('click', openExplainModal);
    el('#solveExplainCloseBtn').addEventListener('click', () => el('#solveExplainModal').classList.add('hidden'));
    el('#solveExplainGenBtn').addEventListener('click', onSolveExplainGenerate);
    el('#solveExplainManualBtn').addEventListener('click', onManualExplainClick);
    el('#solveChoiceRow').addEventListener('click', onChoiceClick);
    el('#solveTextToggle').addEventListener('click', onTextToggleClick);
    el('#solveTimer').addEventListener('click', onTimerToggleClick);

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
    const savedTimerMode = await DB.getMeta(TIMER_MODE_KEY);
    if (savedTimerMode === 'cumulative' || savedTimerMode === 'perVisit') timerMode = savedTimerMode;

    const persisted = await DB.getMeta(SESSION_KEY);
    if (persisted && persisted.questionIds && persisted.questionIds.length && !persisted.submitted) {
      session = persisted;
      // 예전 세션(이 필드들이 생기기 전에 저장된)을 이어 열 때를 대비한 방어적 기본값.
      session.revealed = session.revealed || {};
      session.checkResults = session.checkResults || {};
      session.timeSpent = session.timeSpent || {};
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
      checkResults: {},  // qid -> 'correct' | 'wrong' (가장 마지막으로 "정답 확인"한 결과 — 문제 목록 색상용)
      timeSpent: {},     // qid -> 이번 문제풀이 세션에서 그 문제에 누적으로 머문 초(누적 타이머 모드용)
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
      checkResults: session.checkResults, timeSpent: session.timeSpent,
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
    stopTimer(); // perVisit 표시는 나갔다 들어오면 항상 0초부터 다시 시작하지만, 누적값(session.timeSpent)은
                 // 계속 유지되도록 확정 누적하고 세션에 저장해둔다(누적 타이머 모드가 이어서 보여야 하므로).
    persistSession();
    revokeAllUrls();
    el('#solveOverlay').classList.add('hidden');
    refreshSetupScreen();
  }

  async function goTo(idx) {
    if (idx < 0 || idx >= questions.length) return;
    stopTimer(); // 문제를 벗어나기 전에 지금까지 머문 시간을 session.timeSpent에 확정 누적
    session.index = idx;
    await persistSession();
    render();
  }

  /** 지금 보고 있던 문제의 방금 구간(timerStartTs~지금)을 session.timeSpent에 누적하고
   * 인터벌을 멈춘다. 화면에 뭘 보여주는지(timerMode)와 무관하게 실제 누적은 항상 여기서
   * 이뤄진다 — "누적" 모드는 이렇게 계속 쌓인 값을 그냥 보여주기만 하는 것뿐이다. */
  function stopTimer() {
    if (timerQid) {
      const elapsedSec = Math.floor((Date.now() - timerStartTs) / 1000);
      session.timeSpent[timerQid] = (session.timeSpent[timerQid] || 0) + elapsedSec;
    }
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
   * 리셋되지 않게 하되, 문제가 실제로 바뀌면 지금까지 구간을 확정 누적(stopTimer)하고 새
   * 구간을 시작한다. */
  function ensureTimerFor(qid) {
    if (timerQid === qid && timerInterval) return;
    stopTimer();
    startTimer(qid);
  }

  /** 타이머 배지를 눌러 "방금 들어온 뒤 경과 시간(perVisit)"과 "이번 문제풀이에서 이 문제에
   * 머문 총 누적 시간(cumulative)" 표시를 토글한다. 실제 누적 자체는 항상 진행 중이므로
   * 토글해도 시간이 끊기거나 리셋되지 않는다. */
  function onTimerToggleClick() {
    timerMode = timerMode === 'cumulative' ? 'perVisit' : 'cumulative';
    DB.setMeta(TIMER_MODE_KEY, timerMode);
    updateTimerDisplay();
  }

  function updateTimerDisplay() {
    if (!timerQid) return;
    const elapsedSec = Math.floor((Date.now() - timerStartTs) / 1000);
    const totalSec = timerMode === 'cumulative'
      ? (session.timeSpent[timerQid] || 0) + elapsedSec
      : elapsedSec;
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    const icon = timerMode === 'cumulative' ? '⏱Σ' : '⏱';
    const timerEl = el('#solveTimer');
    if (!timerEl) return;
    timerEl.textContent = `${icon} ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    timerEl.title = timerMode === 'cumulative'
      ? '이 문제풀이에서 이 문제에 머문 총 누적 시간 (클릭하면 "방금 들어온 뒤 경과 시간"으로 전환)'
      : '이 문제에 방금 들어온 뒤 경과한 시간 (클릭하면 "누적 시간"으로 전환)';
  }

  async function render() {
    const q = questions[session.index];
    if (!q) return;

    // 답 선택/정답보기 토글처럼 "같은 문제"를 다시 그리는 호출이면 지금 스크롤 위치를
    // 기억해뒀다가 새로 그린 뒤 그대로 복원한다. 문제 자체가 바뀐 경우(renderedQid !== q.id,
    // 즉 goTo()를 거쳐온 경우)는 복원하지 않아 자연스럽게 스크롤이 맨 위로 초기화된다.
    const sameQuestion = renderedQid === q.id;
    const prevReadingArea = el('.tvReadingArea');
    const savedTextScrollTop = sameQuestion && prevReadingArea ? prevReadingArea.scrollTop : 0;
    const prevImageArea = el('#solveImageArea');
    const savedImageScrollTop = sameQuestion && prevImageArea ? prevImageArea.scrollTop : 0;
    renderedQid = q.id;

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
      if (savedTextScrollTop) {
        const readingArea = el('.tvReadingArea');
        if (readingArea) readingArea.scrollTop = savedTextScrollTop;
      }
    } else {
      const imgArea = el('#solveImageArea');
      imgArea.innerHTML = urlCache.get(q.id).map((u) => `<img src="${u}" alt="문제 이미지">`).join('');
      imgArea.classList.toggle('layout-row', q.partsLayout === 'row');
      if (savedImageScrollTop) imgArea.scrollTop = savedImageScrollTop;
    }

    renderChoices();
    renderAnswerPanel();
    updateBottomBar();
    updateDrawerHighlight();
    updateExplainBtnState();
    el('#solveGradeBtn').textContent = session.submitted ? '결과' : '채점';
  }

  /** "📖 해설" 버튼은 이 문제의 정답을 확인(정답보기 또는 채점)하기 전까지는 비활성 —
   * 풀기 전에 미리 봐버리는 걸 막기 위함. */
  function updateExplainBtnState() {
    const q = questions[session.index];
    const btn = el('#solveExplainBtn');
    if (!q || !btn) return;
    const unlocked = session.submitted || !!session.revealed[q.id];
    btn.disabled = !unlocked;
    btn.title = unlocked ? '해설 보기' : '정답을 확인하면 이용할 수 있습니다';
  }

  /** 해설 팝업 열기. 해설이 비어있으면 안내 문구 + "AI 해설 생성" 버튼을 보여준다. */
  function openExplainModal() {
    const q = questions[session.index];
    if (!q) return;
    const unlocked = session.submitted || !!session.revealed[q.id];
    if (!unlocked) return;
    el('#solveExplainGenStatus').textContent = '';
    const body = el('#solveExplainBody');
    const genWrap = el('#solveExplainGenWrap');
    if (q.explanation && q.explanation.trim()) {
      MarkdownRender.renderInto(body, q.explanation);
      genWrap.classList.add('hidden');
    } else {
      MarkdownRender.renderIntoOrPlaceholder(body, '');
      genWrap.classList.remove('hidden');
    }
    el('#solveExplainModal').classList.remove('hidden');
  }

  /** "📝 직접입력" — AI 생성 대신 라이브러리의 상세 편집(해설 textarea)에서 직접 타이핑해
   * 넣고 싶을 때 쓴다. 지금 풀고 있는 이 문제풀이 화면(현재 탭)은 그대로 둔 채, 해당 문제의
   * 라이브러리 뷰어를 완전히 새 브라우저 탭으로 띄운다(같은 앱을 ?qid=문제id 쿼리스트링과
   * 함께 다시 열면, main.js의 초기화 로직이 그 쿼리를 보고 라이브러리 탭 + 상세 뷰어를 자동으로
   * 열어준다 — index.html/js/main.js 참고). 같은 IndexedDB를 그대로 보고 쓰므로 새 탭에서
   * 해설을 저장하면, 이 문제풀이 탭으로 돌아와도(다음에 다시 열 때) 그대로 반영된다.
   * AI 해설 생성 버튼/로직은 건드리지 않고 완전히 별개로 동작한다. */
  function onManualExplainClick() {
    const q = questions[session.index];
    if (!q) return;
    const url = `${location.pathname}?qid=${encodeURIComponent(q.id)}`;
    window.open(url, '_blank');
  }

  async function onSolveExplainGenerate() {
    const q = questions[session.index];
    if (!q) return;
    const apiKey = await AIExplain.getApiKey();
    if (!apiKey) { alert('먼저 "설정" 탭에서 Gemini API 키를 등록해주세요.'); return; }
    const btn = el('#solveExplainGenBtn');
    const status = el('#solveExplainGenStatus');
    btn.disabled = true;
    status.textContent = '🤖 해설을 생성하는 중…';
    try {
      // 텍스트로 인식된 문제(q.hasTextChoices)는 AIExplain이 이미지 대신 텍스트를 쓰므로
      // 여기서 굳이 이미지를 안 읽어와도 된다.
      const blobs = q.hasTextChoices ? [] : await DB.getImageBlobs(q);
      const text = await AIExplain.generateForQuestion(q, blobs);
      q.explanation = text; // questions[] 배열의 실제 객체라 여기서 바로 바꿔도 반영됨
      await DB.updateQuestion(q);
      MarkdownRender.renderInto(el('#solveExplainBody'), text);
      el('#solveExplainGenWrap').classList.add('hidden');
    } catch (err) {
      console.error(err);
      status.textContent = '오류: ' + err.message;
    } finally {
      btn.disabled = false;
    }
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
      <div class="tvControlsWrap${solveTvCollapsed ? ' collapsed' : ''}" id="solveTvWrap">
        <button type="button" class="tvControlsToggle" id="solveTvToggle">
          <span>🎨 글자·테마 설정</span><span class="tvControlsChevron">${solveTvCollapsed ? '▸' : '▾'}</span>
        </button>
        <div class="tvControlsPanel">${TextViewPrefs.controlsHtml()}</div>
      </div>
      <div class="tvReadingArea">
        <div class="solveTextStem">${stem}</div>
        <div class="solveTextChoices">${choicesHtml}</div>
      </div>
    `;
    TextViewPrefs.applyTo(area.querySelector('.tvReadingArea'));
    TextViewPrefs.wireControls(area, () => TextViewPrefs.applyTo(area.querySelector('.tvReadingArea')));
    // 설정 패널 자체는 이미 그려져 있으므로(controlsHtml 안의 버튼들), 펼치기/접기 버튼은
    // 다시 그리지 않고 접힘 클래스와 화살표 방향만 토글한다 — 읽던 스크롤 위치 등을 안 건드림.
    el('#solveTvToggle').addEventListener('click', () => {
      solveTvCollapsed = !solveTvCollapsed;
      const wrap = el('#solveTvWrap');
      wrap.classList.toggle('collapsed', solveTvCollapsed);
      wrap.querySelector('.tvControlsChevron').textContent = solveTvCollapsed ? '▸' : '▾';
    });
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
    // 이미 골라둔 선지를 다시 누르면 선택을 해제한다(정답 확인 전까지만 — 확인 후엔
    // showResolved로 버튼이 disabled돼 있어 여기까지 오지 않는다).
    if (session.userAnswers[q.id] === btn.dataset.value) {
      delete session.userAnswers[q.id];
    } else {
      session.userAnswers[q.id] = btn.dataset.value;
    }
    delete session.checkResults[q.id]; // 답을 바꿨으니 이전 "정답 확인" 결과는 더 이상 유효하지 않음 — 다시 확인 전까진 중립(답변함) 색으로
    persistSession();
    render();
  }

  function onRevealClick() {
    const q = questions[session.index];
    session.revealed[q.id] = !session.revealed[q.id];
    // 정답을 "확인"하는 순간(패널을 열 때)의 결과를 기록해둔다 — 문제 목록 색상은 패널을
    // 다시 닫아도(revealed=false) 이 값을 그대로 유지해서 "가장 마지막에 정답 확인한
    // 결과"를 계속 보여준다.
    if (session.revealed[q.id]) recordCheckResult(q);
    persistSession();
    render();
  }

  /** q의 현재 선택 답을 정답과 비교해 session.checkResults에 기록한다. 답을 아예 고르지
   * 않았거나 정답이 등록 안 된 문제는 기록하지 않는다(문제 목록에서 색이 안 붙어야 함). */
  function recordCheckResult(q) {
    if (!q.answer) { delete session.checkResults[q.id]; return; }
    const chosen = session.userAnswers[q.id];
    if (!chosen) { delete session.checkResults[q.id]; return; }
    session.checkResults[q.id] = chosen === String(q.answer) ? 'correct' : 'wrong';
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
    // 해설 본문은 여기 짧게 욱여넣지 않고 "📖 해설" 버튼(하단 바)으로 큰 팝업에서 보여준다
    // (마크다운/수식이 있을 수 있어 이 좁은 패널에 그대로 넣으면 제대로 안 보인다).
    panel.innerHTML = line;
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

  /** 안 푼 문제는 그냥 기본 색(아무 클래스 없음), 푼 문제 중 "가장 마지막으로 정답을
   * 확인"한 결과가 있으면 정답=초록/오답=빨강, 답은 골랐지만 아직 확인 전이면 기존
   * "답변함"(answered) 색을 그대로 쓴다. */
  function updateDrawerHighlight() {
    elAll('.solveDrawerBtn').forEach((btn) => {
      const i = Number(btn.dataset.idx);
      const q = questions[i];
      btn.classList.toggle('current', i === session.index);
      btn.classList.remove('answered', 'correct', 'wrong');
      const chosen = session.userAnswers[q.id];
      const result = session.checkResults[q.id];
      if (result === 'correct') btn.classList.add('correct');
      else if (result === 'wrong') btn.classList.add('wrong');
      else if (chosen) btn.classList.add('answered');
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
    questions.forEach((q) => recordCheckResult(q)); // 채점 = 전체 문제를 한 번에 "정답 확인"한 것으로 취급
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
