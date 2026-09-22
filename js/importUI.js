/* importUI.js — "가져오기" 탭 전체 로직 (다중 파일 큐 지원)
 *
 * 데이터 모델:
 *   batch: [{ id, file, fileName, examMeta:{title,examType,year,subject,round},
 *             startQnum, status, pages, boxes, nextTempId, lastQnum, errorMsg }]
 *   status: 'pending' | 'analyzing' | 'analyzed' | 'reviewed' | 'saving' | 'saved' | 'error'
 *
 * 화면은 두 가지 모드:
 *   1) 목록 모드(#batchListView) — 큐에 담긴 파일들을 한눈에 보고 관리
 *   2) 편집 모드(#reviewEditView) — 목록에서 "편집"을 누른 파일 하나의 박스를 리뷰
 * 편집 모드에 들어갈 때 boxes를 작업용 사본(session)으로 복사해두고,
 * "검토 완료"를 눌러야 실제 항목(item)에 반영된다("취소"를 누르면 버려짐).
 * 실제 DB 저장은 목록 화면의 "전체 저장" 버튼에서 한꺼번에 이루어진다.
 */

const ImportUI = (() => {
  let batch = [];
  let session = null; // 편집 모드에서 사용하는 작업용 사본: {itemRef, examMeta, pages, boxes, nextTempId}
  let drawMode = false; // false | 'question' | 'setIntro' | 'comp'
  let compMode = false;  // 구성요소 보정 화면 여부
  let selectedCompId = null;
  let dragState = null;
  let zoomLevel = 1;

  function el(sel, root = document) { return root.querySelector(sel); }
  function elAll(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
  function uidLocal() { return 'f_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }

  const STATUS_LABEL = {
    pending: '대기중', analyzing: '분석 중…', analyzed: '분석완료',
    reviewed: '검토완료', saving: '저장 중…', saved: '저장됨', error: '오류',
  };

  function init() {
    el('#pdfFiles').addEventListener('change', onFilesChosen);
    el('#drawBoxBtn').addEventListener('click', () => toggleDrawMode('question'));
    el('#drawSetBoxBtn').addEventListener('click', () => toggleDrawMode('setIntro'));
    el('#saveAllBtn').addEventListener('click', onFinishReview);
    el('#compModeBtn').addEventListener('click', toggleCompMode);
    el('#drawCompBtn').addEventListener('click', () => toggleDrawMode('comp'));
    el('#reanalyzeCompBtn').addEventListener('click', () => reanalyzeComps(false));
    el('#reanalyzeAllCompBtn').addEventListener('click', () => reanalyzeComps(true));
    fillKindSelect(el('#newCompKind'), 'text');
    el('#cancelImportBtn').addEventListener('click', onCancelReview);
    el('#toggleSidebarBtn').addEventListener('click', toggleSidebar);

    el('#zoomInBtn').addEventListener('click', () => setZoom(zoomLevel + 0.15));
    el('#zoomOutBtn').addEventListener('click', () => setZoom(zoomLevel - 0.15));
    el('#zoomResetBtn').addEventListener('click', () => setZoom(1));
    el('#reviewAreaScroll').addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(zoomLevel + (e.deltaY < 0 ? 0.1 : -0.1));
    }, { passive: false });

    el('#batchAnalyzeAllBtn').addEventListener('click', onAnalyzeAll);
    el('#batchSaveAllBtn').addEventListener('click', onSaveAllBatch);
    el('#batchClearDoneBtn').addEventListener('click', onClearDone);

    setZoom(1);
    renderBatchList();
  }

  function toggleSidebar() {
    const aside = el('#importSidebar');
    const collapsed = aside.classList.toggle('collapsed');
    el('#toggleSidebarBtn').textContent = collapsed ? '⟩' : '⟨';
  }

  // ==================== 파일 추가 & 목록 렌더링 ====================

  async function onFilesChosen() {
    const files = Array.from(el('#pdfFiles').files || []);
    if (!files.length) return;
    const defaultStart = parseInt(el('#startQnum').value, 10) || 1;

    for (const file of files) {
      const item = {
        id: uidLocal(),
        file,
        fileName: file.name,
        examMeta: { title: file.name.replace(/\.pdf$/i, ''), examType: '', year: '', subject: '', round: '' },
        startQnum: defaultStart,
        status: 'pending',
        pages: null,
        boxes: null,
        nextTempId: 0,
        lastQnum: null,
        errorMsg: '',
      };
      batch.push(item);
      detectHeaderFor(item);
    }
    el('#pdfFiles').value = '';
    renderBatchList();
  }

  async function detectHeaderFor(item) {
    try {
      const guess = await PDFAnalyze.detectHeader(item.file);
      if (guess.title) item.examMeta.title = guess.title;
      if (guess.examType) item.examMeta.examType = guess.examType;
      if (guess.year) item.examMeta.year = guess.year;
      if (guess.subject) item.examMeta.subject = guess.subject;
      // 책형은 오인식이 잦아 자동으로 채우지 않는다.
    } catch (err) {
      console.error(err);
    }
    await applyMemoryDefaults(item);
    renderBatchList();
  }

  // 과목명은 알지만(자동인식 성공 또는 이미 입력됨) 시험유형이 비어있는
  // 경우, 이전에 같은/비슷한 과목에 사용자가 직접 입력해뒀던 시험유형을
  // 기억(ImportMemory)에서 찾아 자동으로 채운다. 과목명 자체를 모르면
  // (다른 시험과 섞일 위험이 있어) 추측하지 않고 건너뛴다.
  async function applyMemoryDefaults(item) {
    if (!window.ImportMemory) return;
    const subj = (item.examMeta.subject || '').trim();
    if (!subj || item.examMeta.examType) return;
    try {
      const hit = await ImportMemory.lookup(subj);
      if (hit && hit.examType) {
        item.examMeta.examType = hit.examType;
        item._examTypeFromMemory = true; // 배지 표시용(아래 buildBatchRow)
      }
    } catch (err) {
      console.error('가져오기 메모리 조회 실패', err);
    }
  }

  // 시험유형/과목 두 칸이 모두 채워진 상태에서 사용자가 입력칸을 벗어나면
  // (blur) 그 조합을 기억에 저장해, 나중에 같은 과목 파일을 가져올 때
  // 시험유형이 자동으로 채워지게 한다.
  function maybeRecordMemory(item) {
    if (!window.ImportMemory) return;
    const subj = (item.examMeta.subject || '').trim();
    const type = (item.examMeta.examType || '').trim();
    if (subj && type) ImportMemory.record(subj, type);
  }

  function renderBatchList() {
    const list = el('#batchList');
    list.innerHTML = '';
    batch.forEach((item) => list.appendChild(buildBatchRow(item)));
    el('#importEmptyState').classList.toggle('hidden', batch.length > 0);
    updateBatchToolbar();
  }

  function updateBatchToolbar() {
    el('#batchCount').textContent = batch.length ? `${batch.length}개 파일` : '추가된 파일 없음';
    el('#batchAnalyzeAllBtn').disabled = !batch.some((b) => b.status === 'pending' || b.status === 'error');
    el('#batchSaveAllBtn').disabled = !batch.some((b) => b.status === 'analyzed' || b.status === 'reviewed');
    el('#batchClearDoneBtn').disabled = !batch.some((b) => b.status === 'saved');
  }

  function buildBatchRow(item) {
    const row = document.createElement('div');
    row.className = 'batchRow';
    row.dataset.id = item.id;

    const top = document.createElement('div');
    top.className = 'batchRowTop';
    const name = document.createElement('span');
    name.className = 'batchFileName';
    name.textContent = item.fileName;
    top.appendChild(name);

    const badge = document.createElement('span');
    badge.className = 'batchStatusBadge status-' + item.status;
    badge.textContent = STATUS_LABEL[item.status] || item.status;
    top.appendChild(badge);

    const codeSpan = document.createElement('span');
    codeSpan.className = 'batchRowCode';
    codeSpan.textContent = DB.Naming.examCode(item.examMeta) || '';
    top.appendChild(codeSpan);
    row.appendChild(top);

    if (item._examTypeFromMemory) {
      const memBadge = document.createElement('span');
      memBadge.className = 'batchRowMemoryBadge';
      memBadge.textContent = '기억된 시험유형 자동입력';
      memBadge.title = '이전에 같은 과목에 직접 입력했던 시험유형을 기억해서 채웠습니다. 다르면 직접 수정해주세요.';
      row.appendChild(memBadge);
    }

    const refreshCode = () => { codeSpan.textContent = DB.Naming.examCode(item.examMeta) || ''; };

    // 이 파일의 특정 항목(예: 연도, 과목) 값을 목록의 다른 모든 파일에
    // 그대로 적용한다. 이미 저장된(status:'saved'/'saving') 파일은 건너뛴다.
    const applyFieldToAll = (key, label) => {
      const value = (item.examMeta[key] || '').trim();
      if (!value) { alert('적용할 값이 비어 있습니다. 먼저 값을 입력해주세요.'); return; }
      const targets = batch.filter((b) => b.id !== item.id && b.status !== 'saved' && b.status !== 'saving');
      if (!targets.length) { alert('적용할 다른 파일이 없습니다.'); return; }
      if (!confirm(`"${label}" 값 "${value}"을(를) 다른 ${targets.length}개 파일에 적용할까요?`)) return;
      targets.forEach((b) => {
        b.examMeta[key] = value;
        b._examTypeFromMemory = false;
      });
      batch.forEach(maybeRecordMemory);
      renderBatchList();
      el('#importStatus').textContent = `"${label}" 값을 ${targets.length}개 파일에 적용했습니다.`;
    };

    const fields = document.createElement('div');
    fields.className = 'batchRowFields';
    fields.appendChild(makeMetaField('제목', item.examMeta, 'title', refreshCode));
    fields.appendChild(makeMetaField('시험유형', item.examMeta, 'examType', refreshCode, 'examTypeList', {
      applyAll: () => applyFieldToAll('examType', '시험유형'),
      onBlur: () => { item._examTypeFromMemory = false; maybeRecordMemory(item); },
    }));
    fields.appendChild(makeMetaField('연도', item.examMeta, 'year', refreshCode, null, {
      applyAll: () => applyFieldToAll('year', '연도'),
    }));
    fields.appendChild(makeMetaField('과목', item.examMeta, 'subject', refreshCode, 'subjectList', {
      applyAll: () => applyFieldToAll('subject', '과목'),
      onBlur: () => maybeRecordMemory(item),
    }));
    fields.appendChild(makeMetaField('책형/회차', item.examMeta, 'round', refreshCode, null, {
      applyAll: () => applyFieldToAll('round', '책형/회차'),
    }));
    fields.appendChild(makeStartQnumField(item));
    row.appendChild(fields);

    if ((item.status === 'analyzed' || item.status === 'reviewed') && item.boxes) {
      const qcount = new Set(item.boxes.filter((b) => b.kind !== 'setIntro').map((b) => b.qnum)).size;
      const setCount = new Set(item.boxes.filter((b) => b.kind === 'setIntro').map((b) => b.setRange.join('-'))).size;
      const overflowCount = item.boxes.filter((b) => b.isOverflowPart).length;
      const msg = document.createElement('div');
      msg.className = 'batchRowMsg';
      msg.textContent = `문제 ${qcount}개 인식 (마지막 번호 ${item.lastQnum || '?'}) · 세트공통박스 ${setCount}개 · 넘김조각 ${overflowCount}개`;
      row.appendChild(msg);
    }
    if (item.status === 'error') {
      const msg = document.createElement('div');
      msg.className = 'batchRowMsg error';
      msg.textContent = item.errorMsg;
      row.appendChild(msg);
    }

    const actions = document.createElement('div');
    actions.className = 'batchRowActions';

    const analyzeBtn = document.createElement('button');
    analyzeBtn.className = 'btnSecondary';
    analyzeBtn.textContent = item.status === 'pending' || item.status === 'error' ? '분석' : '다시 분석';
    analyzeBtn.disabled = item.status === 'analyzing' || item.status === 'saving' || item.status === 'saved';
    analyzeBtn.addEventListener('click', () => analyzeItem(item));
    actions.appendChild(analyzeBtn);

    const editBtn = document.createElement('button');
    editBtn.className = 'btnSecondary';
    editBtn.textContent = '박스 편집';
    editBtn.disabled = !(item.status === 'analyzed' || item.status === 'reviewed');
    editBtn.addEventListener('click', () => openReview(item));
    actions.appendChild(editBtn);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btnDanger';
    removeBtn.textContent = '목록에서 삭제';
    removeBtn.disabled = item.status === 'saving' || item.status === 'analyzing';
    removeBtn.addEventListener('click', () => removeItem(item.id));
    actions.appendChild(removeBtn);

    row.appendChild(actions);
    return row;
  }

  function makeMetaField(labelText, obj, key, onChange, listId, opts) {
    const wrap = document.createElement('label');
    wrap.className = 'metaField';

    const top = document.createElement('span');
    top.className = 'metaFieldLabelRow';
    const labelSpan = document.createElement('span');
    labelSpan.textContent = labelText;
    top.appendChild(labelSpan);
    if (opts && opts.applyAll) {
      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'metaApplyAllBtn';
      applyBtn.textContent = '⇉ 전체적용';
      applyBtn.title = `현재 값을 이 가져오기 목록의 다른 모든 파일에 적용`;
      applyBtn.addEventListener('mousedown', (e) => e.preventDefault()); // 포커스/blur 순서 꼬임 방지
      applyBtn.addEventListener('click', () => opts.applyAll());
      top.appendChild(applyBtn);
    }
    wrap.appendChild(top);

    const input = document.createElement('input');
    input.type = 'text';
    input.value = obj[key] || '';
    if (listId) input.setAttribute('list', listId);
    input.addEventListener('input', () => {
      obj[key] = input.value;
      onChange();
    });
    if (opts && opts.onBlur) input.addEventListener('blur', opts.onBlur);
    wrap.appendChild(input);
    return wrap;
  }

  function makeStartQnumField(item) {
    const label = document.createElement('label');
    label.textContent = '시작번호';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.value = item.startQnum;
    input.addEventListener('input', () => {
      const v = parseInt(input.value, 10);
      item.startQnum = isNaN(v) ? 1 : v;
    });
    label.appendChild(input);
    return label;
  }

  function removeItem(id) {
    const item = batch.find((b) => b.id === id);
    if (!item) return;
    if (!confirm(`"${item.fileName}"을(를) 목록에서 제거할까요? 저장 전이라면 분석 결과도 함께 사라집니다.`)) return;
    batch = batch.filter((b) => b.id !== id);
    renderBatchList();
  }

  function onClearDone() {
    batch = batch.filter((b) => b.status !== 'saved');
    renderBatchList();
  }

  // ==================== 분석 ====================

  function currentAnalyzeOpts() {
    return {
      twoColumn: el('#twoColumnChk').checked,
      headerRatio: parseFloat(el('#headerRatio').value) || 0.06,
      footerRatio: parseFloat(el('#footerRatio').value) || 0.025,
      scale: parseFloat(el('#renderScale').value) || 1.8,
      contentGapLines: parseFloat(el('#contentGapLines').value) || 2.2,
    };
  }

  async function analyzeItem(item) {
    item.status = 'analyzing';
    item.errorMsg = '';
    renderBatchList();
    try {
      if (!item.examMeta.title) item.examMeta.title = item.fileName.replace(/\.pdf$/i, '');
      if (!item.examMeta.examType) item.examMeta.examType = '기타';
      if (!item.examMeta.subject) item.examMeta.subject = '기타';

      const analyzeOpts = currentAnalyzeOpts();
      item.twoColumn = analyzeOpts.twoColumn;
      // 구성요소 분석은 언어논리·자료해석·상황판단 과목에서만 수행한다(다른 과목은 시간도 아끼고 결과도 안 씀).
      analyzeOpts.structure = PDFStructure.isSupportedSubject(item.examMeta.subject);
      const result = await PDFAnalyze.analyze(item.file, {
        ...analyzeOpts,
        startQnum: item.startQnum || 1,
        onPage: (cur, total) => {
          el('#importStatus').textContent = `[${item.fileName}] 페이지 분석 중… (${cur}/${total})`;
        },
      });
      item.pages = result.pages;
      item.boxes = result.boxes;
      item.components = result.components || [];
      item.structCols = result.structCols || null; // 구성요소 재분석용(메모리에만 보관)
      item.lastQnum = result.lastQnum;
      item.nextTempId = 0;
      item.status = 'analyzed';
      el('#importStatus').textContent = `[${item.fileName}] 분석 완료.`;
    } catch (err) {
      console.error(err);
      item.status = 'error';
      item.errorMsg = '분석 실패: ' + err.message;
      el('#importStatus').textContent = `[${item.fileName}] 분석 중 오류: ${err.message}`;
    }
    renderBatchList();
  }

  async function onAnalyzeAll() {
    const targets = batch.filter((b) => b.status === 'pending' || b.status === 'error');
    if (!targets.length) return;
    el('#batchAnalyzeAllBtn').disabled = true;
    for (const item of targets) {
      await analyzeItem(item);
    }
    el('#batchAnalyzeAllBtn').disabled = false;
    el('#importStatus').textContent = `일괄 분석 완료 (${targets.length}개 파일).`;
  }

  // ==================== 편집(박스 리뷰) 모드 ====================

  function openReview(item) {
    session = {
      itemRef: item,
      examMeta: item.examMeta,
      pages: item.pages,
      boxes: JSON.parse(JSON.stringify(item.boxes)), // 작업용 사본 (취소 시 버려짐)
      comps: JSON.parse(JSON.stringify(item.components || [])),
      nextTempId: item.nextTempId || 0,
    };
    el('#batchListView').classList.add('hidden');
    el('#reviewEditView').classList.remove('hidden');
    setZoom(1);
    compMode = false;
    selectedCompId = null;
    updateCompModeAvailability();
    renderReview();
  }

  function onFinishReview() {
    if (!session) return;
    const item = session.itemRef;
    item.boxes = session.boxes;
    item.components = session.comps;
    item.nextTempId = session.nextTempId;
    item.status = 'reviewed';
    backToList();
  }

  function onCancelReview() {
    if (!session) { backToList(); return; }
    if (!confirm('이 화면에서 수정한 내용을 버리고 목록으로 돌아갈까요?')) return;
    backToList();
  }

  function backToList() {
    session = null;
    el('#reviewEditView').classList.add('hidden');
    el('#batchListView').classList.remove('hidden');
    renderBatchList();
  }

  function setZoom(z) {
    zoomLevel = Math.max(0.4, Math.min(2.5, z));
    el('#reviewArea').style.setProperty('--pageZoom', zoomLevel);
    el('#zoomLabel').textContent = Math.round(zoomLevel * 100) + '%';
  }

  function toggleDrawMode(kind) {
    drawMode = drawMode === kind ? false : kind;
    updateDrawButtons();
  }

  function updateDrawButtons() {
    el('#drawBoxBtn').classList.toggle('active', drawMode === 'question');
    el('#drawSetBoxBtn').classList.toggle('active', drawMode === 'setIntro');
    el('#drawCompBtn').classList.toggle('active', drawMode === 'comp');
    el('#drawBoxBtn').textContent = drawMode === 'question' ? '새 박스 그리기 (그리는 중… 클릭해서 취소)' : '＋ 새 박스 그리기';
    el('#drawSetBoxBtn').textContent = drawMode === 'setIntro' ? '세트 공통 박스 (그리는 중… 클릭해서 취소)' : '＋ 세트 공통 박스';
    el('#drawCompBtn').textContent = drawMode === 'comp' ? '구성요소 (그리는 중… 클릭해서 취소)' : '＋ 구성요소 그리기';
  }

  // ==================== 구성요소 보정 ====================

  function fillKindSelect(sel, current) {
    sel.innerHTML = '';
    ['stem', 'data', 'choices'].forEach((g) => {
      const og = document.createElement('optgroup');
      og.label = PDFStructure.GROUP_LABELS[g];
      Object.entries(PDFStructure.KINDS).filter(([, v]) => v.group === g).forEach(([k, v]) => {
        const o = document.createElement('option');
        o.value = k; o.textContent = v.label;
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    sel.value = current;
  }

  function compSupported() {
    return !!(session && PDFStructure.isSupportedSubject(session.examMeta && session.examMeta.subject));
  }

  /** 언어논리/자료해석/상황판단이 아닌 과목이면 구성요소 보정 버튼을 비활성화한다. */
  function updateCompModeAvailability() {
    const btn = el('#compModeBtn');
    const ok = compSupported();
    btn.disabled = !ok;
    btn.title = ok
      ? '문제를 설문/자료/선지 구성요소로 나눈 결과를 보고 고칩니다'
      : '구성요소 분석은 언어논리·자료해석·상황판단 과목에서만 사용할 수 있습니다 (현재 과목: ' + ((session && session.examMeta && session.examMeta.subject) || '없음') + ')';
    if (!ok && compMode) toggleCompMode();
    el('#compTools').classList.toggle('hidden', !compMode);
    btn.classList.toggle('active', compMode);
  }

  function toggleCompMode() {
    if (!session) return;
    if (!compMode && !compSupported()) return;
    if (!compMode && !session.itemRef.structCols) {
      alert('이 파일은 구성요소 분석을 하지 않고 분석되었습니다(분석 당시 과목이 대상이 아니었을 수 있어요). 과목을 확인한 뒤 목록에서 "다시 분석"을 눌러주세요.');
      return;
    }
    compMode = !compMode;
    selectedCompId = null;
    if (!compMode && drawMode === 'comp') { drawMode = false; updateDrawButtons(); }
    updateCompModeAvailability();
    redrawBoxes();
  }

  function compContaining(c) {
    // 구성요소의 중심점이 들어 있는 문제/세트 박스 (구성요소가 어느 문제에 속하는지 판단 — 박스 번호를 고쳐도 따라간다)
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    return session.boxes.find((b) => b.pageIndex === c.pageIndex && cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) || null;
  }

  /** 선택한 구성요소가 속한 문제(또는 전체)의 구성요소를 다시 분석한다. */
  function reanalyzeComps(all) {
    if (!session || !session.itemRef.structCols) { alert('재분석에 필요한 분석 데이터가 없습니다. 파일을 다시 분석해주세요.'); return; }
    let parts;
    if (all) {
      if (!confirm('모든 문제의 구성요소를 다시 분석합니다. 지금까지 수정한 구성요소는 사라집니다. 계속할까요?')) return;
      parts = session.boxes;
    } else {
      const sel = session.comps.find((c) => c.id === selectedCompId);
      const owner = sel ? compContaining(sel) : null;
      if (!owner) { alert('먼저 다시 분석할 문제의 구성요소를 하나 클릭해 선택해주세요.'); return; }
      parts = owner.kind === 'setIntro'
        ? session.boxes.filter((b) => b.kind === 'setIntro' && b.setRange.join('-') === owner.setRange.join('-'))
        : session.boxes.filter((b) => b.kind !== 'setIntro' && b.qnum === owner.qnum);
    }
    const inParts = (c) => { const ob = compContaining(c); return !!ob && parts.includes(ob); };
    const fresh = PDFStructure.analyzeAll(parts, session.itemRef.structCols, {});
    session.comps = session.comps.filter((c) => !inParts(c)).concat(fresh);
    selectedCompId = null;
    redrawBoxes();
  }

  function renderReview() {
    const area = el('#reviewArea');
    area.innerHTML = '';
    session.pages.forEach((pg) => {
      const wrap = document.createElement('div');
      wrap.className = 'pageReview';
      wrap.dataset.pageIndex = pg.pageIndex;

      const img = document.createElement('img');
      img.src = pg.canvas.toDataURL('image/jpeg', 0.85);
      img.draggable = false;
      wrap.appendChild(img);

      const overlay = document.createElement('div');
      overlay.className = 'boxOverlay';
      wrap.appendChild(overlay);

      const pageLabel = document.createElement('div');
      pageLabel.className = 'pageLabel';
      pageLabel.textContent = `페이지 ${pg.pageIndex + 1}`;
      wrap.appendChild(pageLabel);

      area.appendChild(wrap);

      attachDrawHandlers(wrap, overlay, pg);
    });
    redrawBoxes();
  }

  function redrawBoxes() {
    elAll('.pageReview').forEach((wrap) => {
      const pageIndex = parseInt(wrap.dataset.pageIndex, 10);
      const pg = session.pages[pageIndex];
      const overlay = el('.boxOverlay', wrap);
      overlay.innerHTML = '';
      session.boxes
        .filter((b) => b.pageIndex === pageIndex)
        .forEach((box) => overlay.appendChild(compMode ? buildDimBoxEl(box, pg) : buildBoxEl(box, pg)));
      if (compMode) {
        session.comps
          .filter((c) => c.pageIndex === pageIndex)
          .forEach((c) => overlay.appendChild(buildCompEl(c, pg)));
      }
    });
  }

  /** 구성요소 보정 화면에서 문제 박스는 흐린 점선 틀로만 보여준다(조작 불가). */
  function buildDimBoxEl(box, pg) {
    const div = document.createElement('div');
    div.className = 'qbox dimBox' + (box.kind === 'setIntro' ? ' setIntroBox' : '');
    div.style.left = (box.x / pg.width) * 100 + '%';
    div.style.top = (box.y / pg.height) * 100 + '%';
    div.style.width = (box.w / pg.width) * 100 + '%';
    div.style.height = (box.h / pg.height) * 100 + '%';
    const tag = document.createElement('div');
    tag.className = 'dimBoxTag';
    tag.textContent = box.kind === 'setIntro' ? '세트 ' + box.setRange.join('-') : '#' + box.qnum;
    div.appendChild(tag);
    return div;
  }

  function buildCompEl(c, pg) {
    const div = document.createElement('div');
    div.className = 'compBox k-' + c.kind + ' g-' + c.group + (c.id === selectedCompId ? ' selected' : '');
    div.style.left = (c.x / pg.width) * 100 + '%';
    div.style.top = (c.y / pg.height) * 100 + '%';
    div.style.width = (c.w / pg.width) * 100 + '%';
    div.style.height = (c.h / pg.height) * 100 + '%';
    div.dataset.id = c.id;

    const label = document.createElement('div');
    label.className = 'compLabel';
    // 선택된 구성요소만 종류 드롭다운을 보여주고, 나머지는 짧은 글자 라벨로(화면이 덜 복잡하도록)
    let kindSel = null;
    if (c.id === selectedCompId) {
      kindSel = document.createElement('select');
      kindSel.className = 'compKindSelect';
      fillKindSelect(kindSel, c.kind);
      kindSel.addEventListener('mousedown', (e) => e.stopPropagation());
      kindSel.addEventListener('change', () => {
        c.kind = kindSel.value;
        c.group = PDFStructure.KINDS[c.kind].group;
        redrawBoxes();
      });
      label.appendChild(kindSel);
    } else {
      const kn = document.createElement('span');
      kn.textContent = PDFStructure.KINDS[c.kind] ? PDFStructure.KINDS[c.kind].label : c.kind;
      label.appendChild(kn);
    }
    if (c.marker) { const m = document.createElement('span'); m.className = 'compMarker'; m.textContent = c.marker; label.appendChild(m); }
    if (c.title) { const t = document.createElement('span'); t.className = 'compTitle'; t.textContent = c.title.slice(0, 16); label.appendChild(t); }
    const del = document.createElement('button');
    del.className = 'qboxDel';
    del.textContent = '×';
    del.title = '이 구성요소 삭제';
    del.addEventListener('mousedown', (e) => e.stopPropagation());
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      session.comps = session.comps.filter((x) => x.id !== c.id);
      if (selectedCompId === c.id) selectedCompId = null;
      redrawBoxes();
    });
    label.appendChild(del);
    div.appendChild(label);

    const handle = document.createElement('div');
    handle.className = 'resizeHandle';
    div.appendChild(handle);

    div.addEventListener('mousedown', (e) => {
      if (e.target === handle || e.target === kindSel || e.target === del) return;
      e.preventDefault();
      if (selectedCompId !== c.id) { selectedCompId = c.id; }
      const wrap = div.closest('.pageReview');
      const imgRect = el('img', wrap).getBoundingClientRect();
      dragState = { mode: 'move', box: c, startX: e.clientX, startY: e.clientY, origX: c.x, origY: c.y, imgRect, pg };
      redrawBoxes();
    });
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectedCompId = c.id;
      const wrap = div.closest('.pageReview');
      const imgRect = el('img', wrap).getBoundingClientRect();
      dragState = { mode: 'resize', box: c, startX: e.clientX, startY: e.clientY, origW: c.w, origH: c.h, imgRect, pg };
    });
    return div;
  }



  function buildBoxEl(box, pg) {
    const isSet = box.kind === 'setIntro';
    const div = document.createElement('div');
    div.className = 'qbox' + (isSet ? ' setIntroBox' : '') + (box.isOverflowPart ? ' overflowBox' : '');
    div.style.left = (box.x / pg.width) * 100 + '%';
    div.style.top = (box.y / pg.height) * 100 + '%';
    div.style.width = (box.w / pg.width) * 100 + '%';
    div.style.height = (box.h / pg.height) * 100 + '%';
    div.dataset.id = box.id;

    const label = document.createElement('div');
    label.className = 'qboxLabel';

    let editEl;
    if (isSet) {
      editEl = document.createElement('input');
      editEl.type = 'text';
      editEl.className = 'setRangeInput';
      editEl.value = box.setRange.join('-');
      editEl.title = '세트 범위 (예: 30-31)';
      editEl.addEventListener('mousedown', (e) => e.stopPropagation());
      editEl.addEventListener('change', () => {
        const m = editEl.value.match(/(\d{1,3})\s*[-~∼～]\s*(\d{1,3})/);
        if (m) box.setRange = [parseInt(m[1], 10), parseInt(m[2], 10)];
        else editEl.value = box.setRange.join('-');
      });
      label.appendChild(document.createTextNode('세트'));
      label.appendChild(editEl);
      if (box.partIndex > 1) {
        const badge = document.createElement('span');
        badge.className = 'partBadge';
        badge.textContent = '조각' + box.partIndex;
        label.appendChild(badge);
      }
    } else {
      editEl = document.createElement('input');
      editEl.type = 'text';
      editEl.value = box.qnum;
      editEl.className = 'qnumInput';
      editEl.addEventListener('mousedown', (e) => e.stopPropagation());
      editEl.addEventListener('change', () => {
        const v = parseInt(editEl.value, 10);
        box.qnum = isNaN(v) ? box.qnum : v;
      });
      label.appendChild(document.createTextNode('#'));
      label.appendChild(editEl);
      if (box.isOverflowPart) {
        const badge = document.createElement('span');
        badge.className = 'partBadge';
        badge.textContent = '조각' + (box.partIndex || '');
        label.appendChild(badge);
      }
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'qboxDel';
    delBtn.textContent = '×';
    delBtn.title = '이 박스 삭제';
    delBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      session.boxes = session.boxes.filter((b) => b.id !== box.id);
      redrawBoxes();
    });
    label.appendChild(delBtn);
    div.appendChild(label);

    const handle = document.createElement('div');
    handle.className = 'resizeHandle';
    div.appendChild(handle);

    div.addEventListener('mousedown', (e) => {
      if (e.target === handle || e.target === editEl || e.target === delBtn) return;
      e.preventDefault();
      const wrap = div.closest('.pageReview');
      const imgRect = el('img', wrap).getBoundingClientRect();
      dragState = { mode: 'move', box, startX: e.clientX, startY: e.clientY, origX: box.x, origY: box.y, imgRect, pg };
    });
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const wrap = div.closest('.pageReview');
      const imgRect = el('img', wrap).getBoundingClientRect();
      dragState = { mode: 'resize', box, startX: e.clientX, startY: e.clientY, origW: box.w, origH: box.h, imgRect, pg };
    });

    return div;
  }

  function attachDrawHandlers(wrap, overlay, pg) {
    overlay.addEventListener('mousedown', (e) => {
      if (!drawMode) return;
      if (e.target !== overlay) return;
      const imgEl = el('img', wrap);
      const imgRect = imgEl.getBoundingClientRect();
      const startXpx = ((e.clientX - imgRect.left) / imgRect.width) * pg.width;
      const startYpx = ((e.clientY - imgRect.top) / imgRect.height) * pg.height;
      dragState = { mode: 'draw', kind: drawMode, pg, startXpx, startYpx, imgRect, overlay };
    });
  }

  document.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const { mode, box, startX, startY, imgRect, pg } = dragState;
    if (mode === 'move') {
      const dxPx = ((e.clientX - startX) / imgRect.width) * pg.width;
      const dyPx = ((e.clientY - startY) / imgRect.height) * pg.height;
      box.x = Math.max(0, Math.min(pg.width - box.w, dragState.origX + dxPx));
      box.y = Math.max(0, Math.min(pg.height - box.h, dragState.origY + dyPx));
      redrawBoxes();
    } else if (mode === 'resize') {
      const dxPx = ((e.clientX - startX) / imgRect.width) * pg.width;
      const dyPx = ((e.clientY - startY) / imgRect.height) * pg.height;
      box.w = Math.max(20, dragState.origW + dxPx);
      box.h = Math.max(20, dragState.origH + dyPx);
      redrawBoxes();
    } else if (mode === 'draw') {
      const { overlay, startXpx, startYpx } = dragState;
      const imgRect2 = dragState.imgRect;
      const curXpx = ((e.clientX - imgRect2.left) / imgRect2.width) * pg.width;
      const curYpx = ((e.clientY - imgRect2.top) / imgRect2.height) * pg.height;
      const x = Math.min(startXpx, curXpx), y = Math.min(startYpx, curYpx);
      const w = Math.abs(curXpx - startXpx), h = Math.abs(curYpx - startYpx);
      let ghost = el('.drawGhost', overlay);
      if (!ghost) {
        ghost = document.createElement('div');
        ghost.className = 'qbox drawGhost';
        overlay.appendChild(ghost);
      }
      ghost.style.left = (x / pg.width) * 100 + '%';
      ghost.style.top = (y / pg.height) * 100 + '%';
      ghost.style.width = (w / pg.width) * 100 + '%';
      ghost.style.height = (h / pg.height) * 100 + '%';
      dragState.cur = { x, y, w, h };
    }
  });

  document.addEventListener('mouseup', () => {
    if (dragState && dragState.mode === 'draw' && dragState.cur) {
      const { x, y, w, h } = dragState.cur;
      if (w > 10 && h > 10) {
        if (dragState.kind === 'comp') {
          const kind = el('#newCompKind').value || 'text';
          const c = {
            id: 'mc_' + (session.nextTempId++) + '_' + Date.now(),
            qnum: null, setRange: null, pageIndex: dragState.pg.pageIndex,
            x, y, w, h, kind, group: PDFStructure.KINDS[kind].group, title: '', text: '',
          };
          session.comps.push(c);
          selectedCompId = c.id;
        } else if (dragState.kind === 'setIntro') {
          const maxQnum = Math.max(1, ...session.boxes.filter((b) => b.kind !== 'setIntro').map((b) => b.qnum || 0));
          session.boxes.push({
            id: 'manualSet_' + (session.nextTempId++) + '_' + Date.now(),
            pageIndex: dragState.pg.pageIndex,
            x, y, w, h,
            kind: 'setIntro',
            setRange: [maxQnum, maxQnum + 1],
          });
        } else {
          const maxQnum = session.boxes.filter((b) => b.kind !== 'setIntro').reduce((m, b) => Math.max(m, b.qnum || 0), 0);
          session.boxes.push({
            id: 'manual_' + (session.nextTempId++) + '_' + Date.now(),
            pageIndex: dragState.pg.pageIndex,
            x, y, w, h,
            qnum: maxQnum + 1,
            stemText: '',
          });
        }
      }
      drawMode = false;
      updateDrawButtons();
      redrawBoxes();
    }
    dragState = null;
  });

  // ==================== 전체 저장(DB 커밋) ====================

  /**
   * 리뷰에서 확정된 구성요소(페이지 픽셀 좌표)를, 이 문제를 이루는 조각(parts, 저장 순서 = 이미지 순서)
   * 기준의 0~1 정규화 좌표로 바꾼다. 어느 조각에 속하는지는 구성요소 중심점이 들어 있는 조각으로 판단한다.
   * 결과: [{id, group, kind, title, text, marker, part, x, y, w, h}] (part = 이미지 인덱스)
   */
  function mapComponentsToParts(item, parts) {
    const out = [];
    (item.components || []).forEach((c) => {
      const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
      const pi = parts.findIndex((p) => p.pageIndex === c.pageIndex && cx >= p.x && cx <= p.x + p.w && cy >= p.y && cy <= p.y + p.h);
      if (pi < 0) return;
      const p = parts[pi];
      const x0 = Math.max(p.x, c.x), y0 = Math.max(p.y, c.y);
      const x1 = Math.min(p.x + p.w, c.x + c.w), y1 = Math.min(p.y + p.h, c.y + c.h);
      if (x1 - x0 < 4 || y1 - y0 < 4) return;
      out.push({
        id: c.id, group: c.group, kind: c.kind,
        title: (c.title || '').slice(0, 60), text: (c.text || '').slice(0, 120), marker: c.marker || '',
        // body: 텍스트 보기/혼합 보기에서 쓰는 정리된 본문(줄바꿈 포함). 수동으로 그린 구성요소는 없을 수 있다.
        ...(c.body ? { body: c.body.slice(0, 8000) } : {}),
        part: pi,
        x: (x0 - p.x) / p.w, y: (y0 - p.y) / p.h, w: (x1 - x0) / p.w, h: (y1 - y0) / p.h,
      });
    });
    out.sort((a, b) => a.part - b.part || a.y - b.y || a.x - b.x);
    return out;
  }

  async function saveItemToDB(item) {
    const extractChoices = el('#extractChoicesChk').checked;
    let choicesSaved = 0;
    const exam = await DB.addExam({
      title: item.examMeta.title,
      examType: item.examMeta.examType,
      year: item.examMeta.year,
      subject: item.examMeta.subject,
      round: item.examMeta.round,
      sourceFileName: item.fileName,
    });

    const setBoxes = item.boxes.filter((b) => b.kind === 'setIntro');
    const questionBoxes = item.boxes.filter((b) => b.kind !== 'setIntro');

    const groups = {};
    questionBoxes.forEach((b) => {
      if (!groups[b.qnum]) groups[b.qnum] = [];
      groups[b.qnum].push(b);
    });
    setBoxes.forEach((sb) => {
      const [a, b] = sb.setRange;
      for (let n = Math.min(a, b); n <= Math.max(a, b); n++) {
        if (!groups[n]) groups[n] = [];
        groups[n].push(sb);
      }
    });

    const qnums = Object.keys(groups).map(Number).sort((a, b) => a - b);
    let saved = 0;
    for (const qn of qnums) {
      // 조각 순서 = 지면을 읽는 순서(페이지 → 왼쪽/오른쪽 열 → 위에서 아래). 예전엔 (페이지, y)만
      // 봐서, 같은 페이지에서 왼쪽 열 아래에서 오른쪽 열 위로 이어지는 문제/세트 지문의 조각
      // 순서가 뒤집혔다(오른쪽 열 조각의 y가 더 작아서). 열은 박스의 실제 위치(가운데 x)로 판정한다.
      const twoCol = item.twoColumn !== false;
      const colOf = (bx) => {
        const pgx = item.pages[bx.pageIndex];
        return twoCol && pgx && (bx.x + bx.w / 2) > pgx.width / 2 ? 1 : 0;
      };
      const parts = groups[qn].sort((a, b) => a.pageIndex - b.pageIndex || colOf(a) - colOf(b) || a.y - b.y);
      const blobs = [];
      for (const part of parts) {
        const pg = item.pages[part.pageIndex];
        blobs.push(await PDFAnalyze.cropToBlob(pg.canvas, part));
      }

      const hasSetIntro = parts.some((p) => p.kind === 'setIntro');
      const hasOverflow = parts.some((p) => p.isOverflowPart);
      const partsLayout = !hasSetIntro && hasOverflow ? 'row' : 'stack';

      const thumbSourcePart = parts.find((p) => p.kind !== 'setIntro') || parts[0];
      const thumbPg = item.pages[thumbSourcePart.pageIndex];
      const thumb = PDFAnalyze.cropToThumbDataURL(thumbPg.canvas, thumbSourcePart);

      const stemText = parts.map((p) => p.stemText).filter(Boolean).join(' ');
      const tags = Tagger.suggestTags(exam.subject, stemText);
      if (hasSetIntro) tags.push('세트문제');

      // ---- 설문(발문)/선지 텍스트 — "선지만 추출" 체크박스와 무관하게 항상 계산 ----
      // combinedText는 박스 전체(발문+선지) 텍스트를 이어붙인 것(세트 공통지문(setIntro)
      // 조각은 선지를 안 담고 있으므로 제외). 이 중 첫 원문자 마커 이전이 발문이다.
      // searchText는 "설문이나 선지 텍스트로 문제 검색"에 쓰는 통합 검색용 필드 —
      // 발문+선지 텍스트가 전부 들어있으므로, "선지 텍스트도 함께 추출" 체크박스를
      // 꺼둬서 choices 스토어에 개별 레코드가 안 만들어진 경우에도 검색만큼은 항상 된다.
      const combinedText = parts
        .filter((p) => p.kind !== 'setIntro')
        .map((p) => p.fullText || '')
        .join(' ');
      const stemFullText = PDFAnalyze.extractStem(combinedText);
      const searchText = combinedText.replace(/\s+/g, ' ').trim();

      // ---- 구성요소(설문/자료/선지) — 언어논리·자료해석·상황판단만 ----
      const components = PDFStructure.isSupportedSubject(exam.subject) ? mapComponentsToParts(item, parts) : null;

      const question = {
        id: DB.uid('q'),
        examId: exam.id,
        examTitle: exam.title,
        examType: exam.examType,
        examYear: exam.year,
        subject: exam.subject,
        round: exam.round,
        qnum: qn,
        code: DB.Naming.questionCode(exam.code, qn),
        tags: Array.from(new Set(tags)),
        partsLayout,
        answer: '',
        explanation: '',
        memo: '',
        thumb,
        stemFullText,
        searchText,
        hasTextChoices: false, // 아래서 선지 추출에 성공하면(마커 2개 이상) true로 덮어씀
        createdAt: Date.now(),
      };
      if (components) question.components = components;

      // ---- 선지만 추출(텍스트) — 사이드바 "선지 텍스트도 함께 추출" 체크박스 ----
      // 마커가 2개 미만으로 잡히면(선지가 표/그래프 이미지인 문제) splitChoices가
      // 빈 배열을 반환하므로 자동으로 건너뛰어지고, hasTextChoices도 false로 남는다
      // — "설문+선지 전부 텍스트일 때만 텍스트 보기/풀기 토글을 보여준다"는 기준이
      // 자연히 지켜진다(문제 뷰어/문제풀이 쪽에서 이 플래그로 토글 노출 여부를 정함).
      let choiceRecords = null;
      if (extractChoices) {
        const found = PDFAnalyze.splitChoices(combinedText);
        if (found.length) {
          question.hasTextChoices = true;
          choiceRecords = found.map((c) => ({
            id: DB.uid('c'),
            questionId: question.id,
            examId: exam.id,
            examTitle: exam.title,
            examType: exam.examType,
            examYear: exam.year,
            subject: exam.subject,
            round: exam.round,
            qnum: qn,
            questionCode: question.code,
            code: `${question.code}_${c.marker}`,
            marker: c.marker,
            markerIndex: c.index,
            text: c.text,
            tags: question.tags.slice(), // "태그(기존활용)": 소속 문제의 태그를 기본값으로 물려받아 시작
            ox: null, // 'O' | 'X' | null(미정) — 라이브러리 "선지 보기"에서 체크
            explanation: '', // AI 자동 해설 생성 또는 직접 작성(choices.js, aiExplain.js 참고)
            memo: '',
            createdAt: Date.now(),
          }));
        }
      }
      await DB.addQuestion(question, blobs);
      if (choiceRecords) {
        await DB.addChoices(choiceRecords);
        choicesSaved += choiceRecords.length;
      }

      saved++;
      el('#importStatus').textContent = `[${item.fileName}] 저장 중… (${saved}/${qnums.length})`;
    }
    return { examTitle: exam.title, code: exam.code, count: saved, choicesSaved };
  }

  async function onSaveAllBatch() {
    const targets = batch.filter((b) => b.status === 'analyzed' || b.status === 'reviewed');
    if (!targets.length) {
      alert('저장할 파일이 없습니다. 먼저 "분석"을 실행해주세요.');
      return;
    }
    if (!confirm(`${targets.length}개 문제지를 라이브러리에 저장할까요?`)) return;

    el('#batchSaveAllBtn').disabled = true;
    const results = [];
    const failures = [];
    for (const item of targets) {
      item.status = 'saving';
      renderBatchList();
      try {
        const r = await saveItemToDB(item);
        item.status = 'saved';
        results.push(`"${r.examTitle}" (${r.code}) — ${r.count}문제` + (r.choicesSaved ? ` (선지 ${r.choicesSaved}개 추출)` : ''));
      } catch (err) {
        console.error(err);
        item.status = 'error';
        item.errorMsg = '저장 실패: ' + err.message;
        failures.push(item.fileName);
      }
      renderBatchList();
    }
    el('#batchSaveAllBtn').disabled = false;
    el('#importStatus').textContent = `일괄 저장 완료: ${results.length}개 문제지 저장됨${failures.length ? `, ${failures.length}개 실패` : ''}.`;

    window.LibraryUI && window.LibraryUI.refresh();
    if (results.length) {
      alert(`저장 완료:\n\n${results.join('\n')}` + (failures.length ? `\n\n실패: ${failures.join(', ')}` : ''));
      window.App && window.App.switchTab('library');
    }
  }

  return { init };
})();

window.ImportUI = ImportUI;
