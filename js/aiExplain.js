/* aiExplain.js — Google AI Studio(Gemini) API로 문제/선지 해설을 자동 생성.
 *
 * 이 앱은 서버 없는 완전 정적 웹앱(깃허브 페이지 등에 그대로 올려 쓰는 걸 전제)이라,
 * 브라우저에서 바로 generativelanguage.googleapis.com 의 generateContent 엔드포인트를
 * 호출한다(별도 프록시/백엔드 불필요 — x-goog-api-key 헤더 방식은 브라우저 직접 호출을
 * 지원한다). API 키는 "설정" 탭에서 입력받아 DB.setMeta로 **이 브라우저에만** 저장한다
 * (다른 기기/브라우저와 동기화되지 않음 — 백업 파일에도 포함하지 않는다. 키가 든 백업을
 * 실수로 남에게 공유하는 사고를 막기 위해서다). 다만 이 앱 자체가 클라이언트 코드로만
 * 동작하므로 브라우저 개발자도구에서는 키가 그대로 보인다는 점은 감안해야 한다(개인용
 * 로컬 사용 전제 — 여러 사람이 같이 쓰는 배포라면 키를 공유 계정에 두지 말 것).
 *
 * 응답 형식: JSON 스키마(responseSchema) 모드는 구글 검색 그라운딩(tools:googleSearch)과
 * 같은 요청에 함께 쓸 수 없다(둘 다 켜면 400 에러). 이 앱은 "법령/판례 등은 최신 정보를
 * 검색해서 반영하고, 근거 없는 내용은 지어내지 말 것"이 우선순위가 높다고 보고 JSON 모드
 * 대신 **그라운딩을 켜고 일반 텍스트(마크다운)를 그대로 받는 방식**을 쓴다 — 어차피
 * 필요한 건 해설 문자열 하나뿐이라 JSON으로 감쌀 실익도 적다.
 */

const AIExplain = (() => {
  const API_KEY_META = 'geminiApiKey';
  const MODEL_META = 'geminiModel';
  const GROUNDING_META = 'geminiUseGrounding';
  // 'gemini-flash-latest'는 구글이 계속 최신 flash 모델로 갱신해주는 별칭이라, 특정
  // 버전명을 하드코딩해서 나중에 그 모델이 폐지됐을 때 앱이 깨지는 걸 피할 수 있다.
  // 이미지(문제 스캔본)를 함께 보내야 하므로 멀티모달 지원 flash 계열이면 충분하다.
  const DEFAULT_MODEL = 'gemini-flash-latest';

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function getApiKey() { return (await DB.getMeta(API_KEY_META)) || ''; }
  async function setApiKey(key) { await DB.setMeta(API_KEY_META, String(key || '').trim()); }
  async function getModel() { return (await DB.getMeta(MODEL_META)) || DEFAULT_MODEL; }
  async function setModel(model) { await DB.setMeta(MODEL_META, String(model || '').trim() || DEFAULT_MODEL); }
  /** 기본 on — 법령/판례/시사성 있는 내용을 최신 상태로 반영하고 환각을 줄이는 데 중요하다. */
  async function getUseGrounding() { const v = await DB.getMeta(GROUNDING_META); return v === undefined || v === null ? true : !!v; }
  async function setUseGrounding(v) { await DB.setMeta(GROUNDING_META, !!v); }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result); // "data:image/jpeg;base64,AAAA..."
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function blobsToInlineParts(blobs) {
    const parts = [];
    for (const b of blobs || []) {
      if (!b) continue;
      const dataUrl = await blobToBase64(b);
      const commaIdx = dataUrl.indexOf(',');
      const meta = dataUrl.slice(0, commaIdx);
      const data = dataUrl.slice(commaIdx + 1);
      const mimeMatch = /data:(.*?);base64/.exec(meta);
      parts.push({ inlineData: { mimeType: (mimeMatch && mimeMatch[1]) || 'image/jpeg', data } });
    }
    return parts;
  }

  // 모든 생성 요청에 공통으로 붙이는 지침. 마크다운/수식 표기 규칙은 화면 렌더러
  // (markdownRender.js, KaTeX)가 실제로 인식하는 구분자와 정확히 맞춰야 한다 —
  // 렌더러는 통화 표기($100 등)와 헷갈리지 않도록 홑따옴표 $ 는 수식 구분자로 안 쓰고
  // \( \)(인라인)과 $$ $$(블록)만 처리하므로, 프롬프트도 그 두 가지만 쓰게 지시한다.
  const COMMON_RULES = `[작성 규칙]
- 한국어로, 학습자가 이해하기 쉽게 작성할 것.
- 정답이 왜 정답인지 근거를 들어 설명하고, 가능하면 나머지 오답(또는 틀린 선지)이 왜
  틀렸는지도 짧게 짚어줄 것.
- 해설에 필요한 배경 개념이나 공식이 있으면 간단히 함께 설명해서 이해를 도울 것(단,
  본 주제에서 크게 벗어난 배경지식까지 장황하게 늘어놓지는 말 것).
- 수식은 인라인은 \\( ... \\), 줄을 바꿔 독립된 수식으로 보여줄 때는 $$ ... $$ 로 감쌀 것.
  홑따옴표 $ 기호 하나만 단독으로 쓰지 말 것(화폐 금액은 "100달러"처럼 풀어쓸 것).
- 마크다운 문법(굵게 **, 목록 -, 표 등)은 자유롭게 써도 되지만 제목(#)은 쓰지 말 것.
- **법령 조문번호, 판례번호(사건번호), 통계 수치, 날짜처럼 사실관계가 중요한 내용은
  검색 결과로 확인된 것만 적을 것. 확실하지 않으면 정확한 조문/판례번호를 지어내지
  말고 "정확한 조문 번호는 별도 확인이 필요합니다"처럼 솔직하게 밝힐 것. 법령은
  개정되었을 수 있으니 시행일 기준으로 최신 조문을 우선할 것.**
- 해설 본문만 출력하고, "네, 알겠습니다" 같은 인사말이나 부연 설명은 붙이지 말 것.`;

  async function callGemini({ apiKey, model, parts, useGrounding }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const body = { contents: [{ role: 'user', parts }] };
    if (useGrounding) body.tools = [{ googleSearch: {} }];
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      const err = new Error('요청이 몰려 잠시 대기 후 재시도합니다(429).');
      err.rateLimited = true;
      throw err;
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error?.message || ''; } catch (e) { /* 무시 */ }
      throw new Error(`Gemini API 오류 (${res.status})${detail ? ': ' + detail : ''}`);
    }
    const data = await res.json();
    const cand = data.candidates && data.candidates[0];
    if (!cand) {
      const reason = data.promptFeedback?.blockReason;
      throw new Error(reason ? `모델이 응답을 거부했습니다(${reason}).` : '빈 응답을 받았습니다.');
    }
    const text = (cand.content?.parts || []).map((p) => p.text || '').join('').trim();
    if (!text) throw new Error('빈 응답을 받았습니다.');

    // 그라운딩(검색)을 썼으면 실제 참고한 출처를 해설 맨 아래에 붙여준다 — "최신 정보를
    // 반영했다"는 걸 사용자가 직접 확인할 수 있게(구글 그라운딩 이용약관상 출처 표시 권장).
    const chunks = cand.groundingMetadata?.groundingChunks || [];
    const sources = chunks.map((c) => c.web).filter((w) => w && w.uri)
      .filter((w, i, arr) => arr.findIndex((x) => x.uri === w.uri) === i)
      .slice(0, 6);
    if (sources.length) {
      const list = sources.map((s) => `- [${(s.title || s.uri).replace(/\]/g, ')')}](${s.uri})`).join('\n');
      return `${text}\n\n---\n**참고한 검색 출처**\n${list}`;
    }
    return text;
  }

  /** 429(rate limit)만 짧은 대기 후 재시도, 그 외 오류는 바로 위로 던진다. */
  async function withRetry(fn, retries = 3) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try { return await fn(); } catch (e) {
        lastErr = e;
        if (e.rateLimited && i < retries) { await sleep(1500 * (i + 1)); continue; }
        throw e;
      }
    }
    throw lastErr;
  }

  async function commonConfig() {
    const apiKey = await getApiKey();
    if (!apiKey) throw new Error('Gemini API 키가 설정돼 있지 않습니다. 설정 탭에서 등록해주세요.');
    const model = await getModel();
    const useGrounding = await getUseGrounding();
    return { apiKey, model, useGrounding };
  }

  /**
   * 문제 이미지+텍스트로 해설을 생성한다. 이미지는 항상 함께 보낸다(문제 자체가 스캔
   * 이미지라 표/그림이 텍스트에 안 담기는 경우가 많기 때문 — "이미지도 함께 전송" 설정).
   * @param {object} question DB.getQuestion()으로 얻은 문제 레코드
   * @param {Blob[]} imageBlobs DB.getImageBlobs(question) 결과
   */
  async function generateForQuestion(question, imageBlobs) {
    const { apiKey, model, useGrounding } = await commonConfig();
    const imageParts = await blobsToInlineParts(imageBlobs);
    const contextLines = [
      [question.examTitle, question.subject, question.round].filter(Boolean).join(' '),
      `문제 번호: ${question.qnum ?? ''}번`,
      question.answer ? `이 앱에 등록된 정답: ${question.answer}번 (이 정답을 기준으로 해설할 것)` : '정답이 아직 등록되지 않음 — 이미지 내용을 보고 스스로 정답을 판단해서 해설할 것.',
    ].filter(Boolean).join('\n');

    const promptText = `다음은 객관식 시험 문제를 스캔한 이미지입니다. 이 문제를 분석해서 해설을
작성해주세요. 필요하다면(예: 법령/판례가 등장하는 문제, 시사성 있는 통계가 필요한 문제)
구글 검색으로 최신 정보를 확인한 뒤 반영하세요.

${COMMON_RULES}

[문제 정보]
${contextLines}`;

    return withRetry(() => callGemini({ apiKey, model, useGrounding, parts: [{ text: promptText }, ...imageParts] }));
  }

  /**
   * 개별 선지(OX형 등, choices 스토어의 레코드) 하나에 대한 해설을 생성한다.
   * @param {object} choice DB.getChoice() 레코드 ({ text, marker, ox, ... })
   * @param {Blob[]} [questionImageBlobs] 선택. 소속 문제의 원본 이미지(참고용, 함께 전송)
   */
  async function generateForChoice(choice, questionImageBlobs) {
    const { apiKey, model, useGrounding } = await commonConfig();
    const imageParts = await blobsToInlineParts(questionImageBlobs);
    const marker = (window.PDFAnalyze && PDFAnalyze.markerToPlain) ? PDFAnalyze.markerToPlain(choice.marker) : (choice.marker || '');
    const oxLine = choice.ox
      ? `참고: 이 선지는 사람이 미리 "${choice.ox}"로 정오 판정을 해뒀습니다. 이 판정을 기준으로 왜 그런지 해설하세요.`
      : '참고: 이 선지의 정오가 아직 표시되지 않았습니다 — 내용상 맞는 설명인지 스스로 판단해서 해설하세요.';

    const promptText = `다음은 객관식(또는 OX형) 시험 문제에 속한 선지(보기) 하나입니다. 이 선지가
맞는 설명인지 틀린 설명인지 해설해주세요. 필요하다면 구글 검색으로 최신 정보를 확인한
뒤 반영하세요.

${COMMON_RULES}

[선지 ${marker}] ${choice.text || ''}
${oxLine}
${imageParts.length ? '(첨부한 이미지는 이 선지가 속한 원본 문제입니다 — 필요할 때만 참고하세요.)' : ''}`;

    return withRetry(() => callGemini({ apiKey, model, useGrounding, parts: [{ text: promptText }, ...imageParts] }));
  }

  /** API 키가 실제로 유효한지 가볍게 확인(설정 탭 "연결 테스트"용). 그라운딩/이미지 없이
   * 최소 토큰으로만 호출해서 빠르고 저렴하게 검증한다. */
  async function testConnection() {
    const apiKey = await getApiKey();
    if (!apiKey) throw new Error('API 키를 먼저 입력해주세요.');
    const model = await getModel();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: '한 단어로만: 안녕' }] }] }),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error?.message || ''; } catch (e) { /* 무시 */ }
      throw new Error(`연결 실패 (${res.status})${detail ? ': ' + detail : ''}`);
    }
    return true;
  }

  // ==================== 일괄 실행(진행 모달) ====================

  /** items를 순차 처리하며 진행 상황을 onProgress로 알려주는 범용 배치 러너.
   * skip(item)이 true면 API 호출 없이 건너뛴다(이미 해설이 있는 문제/선지 스킵용).
   * task(item)은 생성+저장까지 책임지며, 실패 시 throw하면 failed로 집계된다.
   * cancelToken.cancelled가 true가 되면 다음 항목 진입 전에 멈춘다. */
  async function runBatch(items, { skip, task, onProgress, cancelToken }) {
    const total = items.length;
    let done = 0, skipped = 0, failed = 0;
    for (const item of items) {
      if (cancelToken && cancelToken.cancelled) break;
      done++;
      if (skip && skip(item)) {
        skipped++;
        onProgress && onProgress({ done, total, skipped, failed, item, status: 'skipped' });
        continue;
      }
      try {
        await task(item);
        onProgress && onProgress({ done, total, skipped, failed, item, status: 'ok' });
      } catch (e) {
        failed++;
        onProgress && onProgress({ done, total, skipped, failed, item, status: 'error', error: e });
      }
    }
    return { total, done, skipped, failed, cancelled: !!(cancelToken && cancelToken.cancelled) };
  }

  /** library.js/choices.js가 공용으로 쓰는 일괄 생성 진행 모달(#aiExplainBatchModal, index.html).
   * 반환값은 runBatch()의 완료 요약을 담은 Promise. */
  function openBatchModal({ title, hint, items, skip, task, itemLabel }) {
    const modal = document.getElementById('aiExplainBatchModal');
    const titleEl = document.getElementById('aiExplainBatchTitle');
    const hintEl = document.getElementById('aiExplainBatchHint');
    const fillEl = document.getElementById('aiExplainBatchFill');
    const statusEl = document.getElementById('aiExplainBatchStatus');
    const logEl = document.getElementById('aiExplainBatchLog');
    const cancelBtn = document.getElementById('aiExplainBatchCancelBtn');
    const closeBtn = document.getElementById('aiExplainBatchCloseBtn');

    titleEl.textContent = title;
    hintEl.textContent = hint || '';
    fillEl.style.width = '0%';
    statusEl.textContent = `0 / ${items.length}`;
    logEl.innerHTML = '';
    cancelBtn.classList.remove('hidden');
    cancelBtn.disabled = false;
    cancelBtn.textContent = '중단';
    closeBtn.classList.add('hidden');
    modal.classList.remove('hidden');

    const cancelToken = { cancelled: false };
    const onCancelClick = () => { cancelToken.cancelled = true; cancelBtn.disabled = true; cancelBtn.textContent = '중단 중…'; };
    cancelBtn.addEventListener('click', onCancelClick, { once: true });

    function appendLog(text, cls) {
      const line = document.createElement('div');
      line.className = 'aiExplainBatchLogLine' + (cls ? ' ' + cls : '');
      line.textContent = text;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    }

    const runPromise = runBatch(items, {
      skip,
      task,
      cancelToken,
      onProgress: ({ done, total, item, status, error }) => {
        fillEl.style.width = `${Math.round((done / total) * 100)}%`;
        statusEl.textContent = `${done} / ${total}`;
        const label = itemLabel ? itemLabel(item) : '';
        if (status === 'ok') appendLog(`✓ ${label}`, 'ok');
        else if (status === 'skipped') appendLog(`– ${label} (이미 해설 있음, 건너뜀)`, 'skip');
        else appendLog(`✕ ${label}: ${(error && error.message) || '실패'}`, 'err');
      },
    }).then((summary) => {
      cancelBtn.classList.add('hidden');
      closeBtn.classList.remove('hidden');
      const madeCount = summary.done - summary.skipped - summary.failed;
      const cancelledNote = summary.cancelled ? ` (중단됨, ${summary.total - summary.done}개 미처리)` : '';
      hintEl.textContent = `완료: 생성 ${Math.max(madeCount, 0)}개 · 건너뜀 ${summary.skipped}개 · 실패 ${summary.failed}개${cancelledNote}`;
      return summary;
    });

    closeBtn.addEventListener('click', () => modal.classList.add('hidden'), { once: true });
    return runPromise;
  }

  return {
    DEFAULT_MODEL,
    getApiKey, setApiKey, getModel, setModel, getUseGrounding, setUseGrounding,
    generateForQuestion, generateForChoice, testConnection,
    runBatch, openBatchModal,
  };
})();

window.AIExplain = AIExplain;
