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
 * 여러 개의 API 키를 줄바꿈으로 입력해두면, 지금 쓰는 키가 한도 초과(429/할당량 소진)로
 * 실패할 때 자동으로 다음 키로 넘어가서 이어서 시도한다(withKeyRotation 참고) — 무료
 * 티어 키 여러 개를 돌려쓰는 걸 염두에 둔 기능. 성공한 키는 다음 호출의 시작점으로
 * 기억해둬서(geminiApiKeyIndex), 이미 소진된 앞쪽 키부터 매번 다시 시도하며 시간을
 * 낭비하지 않는다.
 *
 * 응답 형식: JSON 스키마(responseSchema) 모드는 구글 검색 그라운딩(tools:googleSearch)과
 * 같은 요청에 함께 쓸 수 없다(둘 다 켜면 400 에러). 이 앱은 "법령/판례 등은 최신 정보를
 * 검색해서 반영하고, 근거 없는 내용은 지어내지 말 것"이 우선순위가 높다고 보고 JSON 모드
 * 대신 **그라운딩을 켜고 일반 텍스트(마크다운)를 그대로 받는 방식**을 쓴다 — 어차피
 * 필요한 건 해설 문자열 하나뿐이라 JSON으로 감쌀 실익도 적다.
 */

const AIExplain = (() => {
  const LEGACY_API_KEY_META = 'geminiApiKey'; // 구버전(키 1개)용 — 마이그레이션 전용, 새로 쓰지 않음
  const API_KEYS_TEXT_META = 'geminiApiKeysText'; // 줄바꿈으로 구분된 여러 키의 원문(설정 탭 textarea 그대로)
  const KEY_INDEX_META = 'geminiApiKeyIndex'; // 다음 호출을 시작할 키의 인덱스(마지막으로 성공한 키를 기억)
  const MODEL_META = 'geminiModel';
  const GROUNDING_META = 'geminiUseGrounding';
  // 'gemini-flash-latest'는 구글이 계속 최신 flash 모델로 갱신해주는 별칭이라, 특정
  // 버전명을 하드코딩해서 나중에 그 모델이 폐지됐을 때 앱이 깨지는 걸 피할 수 있다.
  // 이미지(문제 스캔본)를 함께 보내야 하므로 멀티모달 지원 flash 계열이면 충분하다.
  const DEFAULT_MODEL = 'gemini-flash-latest';

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function parseApiKeys(text) {
    return String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  }

  /** 설정 탭 textarea에 그대로 채워 넣을 원문 텍스트. 예전 버전(키 1개, geminiApiKey)만
   * 저장돼 있던 경우 한 번만 새 저장 방식으로 옮겨준다. */
  async function getApiKeysText() {
    let text = await DB.getMeta(API_KEYS_TEXT_META);
    if (text === null || text === undefined) {
      const legacy = await DB.getMeta(LEGACY_API_KEY_META);
      text = legacy || '';
      if (legacy) await DB.setMeta(API_KEYS_TEXT_META, text);
    }
    return text;
  }
  async function setApiKeysText(text) { await DB.setMeta(API_KEYS_TEXT_META, String(text || '')); }
  async function getApiKeys() { return parseApiKeys(await getApiKeysText()); }

  /** 이전 버전과의 호환/"키가 하나라도 설정돼 있는지" 확인용. 실제 API 호출은
   * withKeyRotation()이 내부적으로 여러 키를 자동으로 돌려가며 쓰므로, 다른 모듈은 이
   * 값을 호출에 직접 쓰지 말고 "설정 여부"를 확인하는 용도로만 써야 한다. */
  async function getApiKey() { const keys = await getApiKeys(); return keys[0] || ''; }
  async function setApiKey(key) { await setApiKeysText(key); }

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

  // 무료 티어 키는 보통 "분당 요청수(RPM)"가 꽤 빡빡하다(예: 분당 10~15회 수준). 일괄
  // 생성처럼 요청을 쉬지 않고 연달아 쏘면 키 자체는 멀쩡해도 이 RPM에 걸려 429가 계속
  // 뜰 수 있어서, 같은 키로는 최소 이 간격만큼 띄엄띄엄 호출하도록 클라이언트 쪽에서
  // 미리 속도를 늦춘다(throttle) — 서버가 실제로 막기 전에 애초에 덜 자주 두드리는 것.
  const MIN_INTERVAL_MS = 4200;
  const lastCallAtByKey = new Map(); // apiKey -> 그 키로 마지막 요청을 "시작"한 시각

  async function throttle(apiKey) {
    const last = lastCallAtByKey.get(apiKey) || 0;
    const waitMs = last + MIN_INTERVAL_MS - Date.now();
    lastCallAtByKey.set(apiKey, Date.now() + Math.max(waitMs, 0));
    if (waitMs > 0) await sleep(waitMs);
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

  /** 429/RESOURCE_EXHAUSTED 오류 바디에서 구글이 실어 보내는 실제 사유 문자열과,
   * (있으면) 서버가 권장하는 재시도 대기시간(RetryInfo.retryDelay, 예: "38s")을 뽑아낸다.
   * 예전엔 이 detail을 버리고 "요청이 몰려…" 같은 뭉뚱그린 메시지만 보여줬는데, 구글
   * 에러 메시지엔 보통 "어떤 할당량 지표"를 초과했는지(분당 요청수인지, 하루 요청수인지,
   * 분당 토큰수인지 등)가 그대로 적혀 있어서 원인 파악에 훨씬 도움이 된다. */
  function parseErrorDetail(json) {
    const detail = json?.error?.message || '';
    const status = json?.error?.status || '';
    let retryDelayMs = null;
    const retryInfo = (json?.error?.details || []).find((d) => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
    const m = retryInfo && /^([\d.]+)s$/.exec(retryInfo.retryDelay || '');
    if (m) retryDelayMs = Math.round(parseFloat(m[1]) * 1000);
    return { detail, status, retryDelayMs };
  }

  async function callGemini({ apiKey, model, parts, useGrounding }) {
    await throttle(apiKey);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const body = { contents: [{ role: 'user', parts }] };
    if (useGrounding) body.tools = [{ googleSearch: {} }];
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let parsed = { detail: '', status: '', retryDelayMs: null };
      try { parsed = parseErrorDetail(await res.json()); } catch (e) { /* 무시 */ }
      const { detail, status, retryDelayMs } = parsed;
      const err = new Error(`Gemini API 오류 (${res.status})${detail ? ': ' + detail : ''}`);
      // RESOURCE_EXHAUSTED는 보통 429로 오지만, 드물게 다른 상태코드에 이 reason이
      // 실려오는 경우도 있어 문자열로도 한 번 더 확인해서 로테이션 대상에 포함시킨다.
      if (res.status === 429 || status === 'RESOURCE_EXHAUSTED' || /quota/i.test(detail)) {
        err.quotaExhausted = true; // 여러 키를 등록해뒀다면 withKeyRotation()이 다음 키로 넘어간다
        err.rateLimited = true;
      }
      if (retryDelayMs) err.retryDelayMs = retryDelayMs;
      throw err;
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

  /** 429(rate limit)만 짧은 대기 후 재시도, 그 외 오류는 바로 위로 던진다. 키 로테이션이
   * 어차피 다음 키로 넘어가 주므로, 여기서는 "진짜 순간적인 튐"만 한 번 커버할 정도로
   * 짧게(재시도 1회) 잡아둔다 — 이미 소진된 키를 붙잡고 오래 기다리지 않기 위해서.
   * 서버가 RetryInfo로 대기시간을 알려줬으면(e.retryDelayMs) 그 값을 우선 쓰고,
   * 없으면 기본 1.2초 — 다만 서버 권장값이 너무 길면(예: 하루 할당량 소진으로 인한
   * 수십 초 대기) 어차피 로테이션이 다음 키로 넘어갈 몫이니 최대 5초로 캡을 둔다. */
  async function withRetry(fn, retries = 1) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try { return await fn(); } catch (e) {
        lastErr = e;
        if (e.rateLimited && i < retries) { await sleep(Math.min(e.retryDelayMs || 1200, 5000)); continue; }
        throw e;
      }
    }
    throw lastErr;
  }

  async function getKeyIndex() {
    const v = await DB.getMeta(KEY_INDEX_META);
    return Number.isInteger(v) ? v : 0;
  }
  async function setKeyIndex(i) { await DB.setMeta(KEY_INDEX_META, i); }

  function isQuotaError(e) { return !!(e && e.quotaExhausted); }

  /**
   * 등록된 여러 키를 자동으로 돌려가며 makeCall(apiKey)를 시도한다. 지금 가리키는
   * 키(geminiApiKeyIndex)부터 시작해서, 한도 초과로 보이는 실패(isQuotaError)면 다음
   * 키로 넘어가고, 그 외 오류(잘못된 요청, 콘텐츠 차단 등 — 키를 바꿔도 소용없는 문제)면
   * 바로 실패 처리한다. 성공하면 그 키의 인덱스를 다음 시작점으로 저장해서, 이미 소진된
   * 앞쪽 키부터 매번 다시 시도하며 시간을 낭비하지 않게 한다.
   */
  async function withKeyRotation(makeCall) {
    const keys = await getApiKeys();
    if (!keys.length) throw new Error('Gemini API 키가 설정돼 있지 않습니다. 설정 탭에서 등록해주세요(한 줄에 하나씩 여러 개 입력 가능).');
    let startIdx = await getKeyIndex();
    if (!Number.isInteger(startIdx) || startIdx < 0 || startIdx >= keys.length) startIdx = 0;

    let lastErr;
    for (let attempt = 0; attempt < keys.length; attempt++) {
      const useIdx = (startIdx + attempt) % keys.length;
      try {
        const result = await withRetry(() => makeCall(keys[useIdx]));
        if (useIdx !== startIdx) await setKeyIndex(useIdx); // 다음 호출은 방금 성공한 키부터
        return result;
      } catch (e) {
        lastErr = e;
        if (!isQuotaError(e)) throw e; // 키를 바꿔도 소용없는 오류는 바로 던짐(다른 키로 재시도 X)
        // 한도 초과로 보이면 다음 키로 넘어가서 계속 시도
      }
    }
    throw new Error(`등록된 API 키 ${keys.length}개를 모두 시도했지만 전부 한도를 초과했습니다. 잠시 후 다시 시도하거나 새 키를 추가해주세요. (마지막 오류: ${lastErr.message})`);
  }

  async function commonConfig() {
    const model = await getModel();
    const useGrounding = await getUseGrounding();
    return { model, useGrounding };
  }

  /** 문제의 발문(question.stemFullText)+선지 텍스트를 사람이 읽기 좋은 블록으로 합친다.
   * hasTextChoices인 문제에서 이미지 대신 이 텍스트를 근거로 쓰기 위함. */
  async function buildQuestionTextBlock(question) {
    const stem = (window.PDFAnalyze && PDFAnalyze.prettifyMarkers)
      ? PDFAnalyze.prettifyMarkers(question.stemFullText) : (question.stemFullText || '');
    const choices = (await DB.getChoicesByQuestion(question.id))
      .slice().sort((a, b) => (a.markerIndex || 0) - (b.markerIndex || 0));
    const choiceLines = choices.map((c) => {
      const marker = (window.PDFAnalyze && PDFAnalyze.markerToPlain) ? PDFAnalyze.markerToPlain(c.marker) : (c.marker || '');
      return `${marker} ${c.text || ''}`;
    }).join('\n');
    return `[문제 발문]\n${stem || '(발문 텍스트 없음)'}\n\n[선지]\n${choiceLines || '(선지 텍스트 없음)'}`;
  }

  /**
   * 문제로 해설을 생성한다. **이 문제가 텍스트로 인식돼 있으면(question.hasTextChoices)
   * 이미지 대신 그 텍스트(발문+선지 원문)를 근거로 쓴다** — 텍스트가 이미 정확하게
   * 추출돼 있는데 굳이 모델에게 다시 이미지를 읽혀서(OCR을 대신 시켜서) 오차를 만들
   * 이유가 없고, 토큰/속도 면에서도 이득이기 때문. 텍스트 인식이 안 된 문제만 이미지를
   * 함께 보낸다(스캔 이미지라 표/그림이 텍스트에 안 담기는 경우가 많음).
   * @param {object} question DB.getQuestion()으로 얻은 문제 레코드
   * @param {Blob[]} imageBlobs DB.getImageBlobs(question) 결과 — question.hasTextChoices가
   *   true면 이 인자는 무시된다(이미지를 안 쓰므로).
   */
  async function generateForQuestion(question, imageBlobs) {
    const { model, useGrounding } = await commonConfig();
    const useText = !!question.hasTextChoices;
    const imageParts = useText ? [] : await blobsToInlineParts(imageBlobs);
    const contextLines = [
      [question.examTitle, question.subject, question.round].filter(Boolean).join(' '),
      `문제 번호: ${question.qnum ?? ''}번`,
      question.answer ? `이 앱에 등록된 정답: ${question.answer}번 (이 정답을 기준으로 해설할 것)` : '정답이 아직 등록되지 않음 — 내용을 보고 스스로 정답을 판단해서 해설할 것.',
    ].filter(Boolean).join('\n');

    const introText = useText
      ? '다음은 객관식 시험 문제를 텍스트로 정확히 옮긴 내용입니다(이미지가 아니라 원문 텍스트이므로 이 내용을 그대로 근거로 삼아 분석하세요).'
      : '다음은 객관식 시험 문제를 스캔한 이미지입니다.';

    const promptText = `${introText} 이 문제를 분석해서 해설을 작성해주세요. 필요하다면(예:
법령/판례가 등장하는 문제, 시사성 있는 통계가 필요한 문제) 구글 검색으로 최신 정보를
확인한 뒤 반영하세요.

${COMMON_RULES}

[문제 정보]
${contextLines}${useText ? `\n\n${await buildQuestionTextBlock(question)}` : ''}`;

    return withKeyRotation((apiKey) => callGemini({ apiKey, model, useGrounding, parts: [{ text: promptText }, ...imageParts] }));
  }

  /**
   * 개별 선지(OX형 등, choices 스토어의 레코드) 하나에 대한 해설을 생성한다. **소속
   * 문제가 텍스트로 인식돼 있으면(question.hasTextChoices) 이미지 대신 그 문제의 발문
   * 텍스트를 함께 근거로 보낸다** — generateForQuestion()과 같은 이유.
   * @param {object} choice DB.getChoice() 레코드 ({ text, marker, ox, ... })
   * @param {object|null} [question] 소속 문제 레코드(DB.getQuestion(choice.questionId)).
   *   없으면(null) 참고 문맥 없이 선지 텍스트만으로 해설한다.
   */
  async function generateForChoice(choice, question) {
    const { model, useGrounding } = await commonConfig();
    const useText = !!(question && question.hasTextChoices);
    let imageParts = [];
    let contextBlock = '';
    if (useText) {
      const stem = (window.PDFAnalyze && PDFAnalyze.prettifyMarkers)
        ? PDFAnalyze.prettifyMarkers(question.stemFullText) : (question.stemFullText || '');
      contextBlock = `참고로 이 선지가 속한 문제의 발문(텍스트로 정확히 옮긴 원문)은 다음과 같습니다:\n${stem || '(발문 텍스트 없음)'}`;
    } else if (question) {
      imageParts = await blobsToInlineParts(await DB.getImageBlobs(question));
    }
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
${contextBlock}
${imageParts.length ? '(첨부한 이미지는 이 선지가 속한 원본 문제입니다 — 필요할 때만 참고하세요.)' : ''}`;

    return withKeyRotation((apiKey) => callGemini({ apiKey, model, useGrounding, parts: [{ text: promptText }, ...imageParts] }));
  }

  /** 등록된 키 각각이 실제로 유효한지 가볍게 확인(설정 탭 "연결 테스트"용). 그라운딩/
   * 이미지 없이 최소 토큰으로만 호출해서 빠르고 저렴하게 검증한다. 여러 키를 등록했다면
   * 하나만 확인하지 않고 전부 확인해서 몇 개가 살아있는지 알려준다. */
  async function pingOnce(apiKey, model) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: '한 단어로만: 안녕' }] }] }),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = parseErrorDetail(await res.json()).detail; } catch (e) { /* 무시 */ }
      throw new Error(`(${res.status})${detail ? ': ' + detail : ''}`);
    }
  }

  async function testConnection() {
    const keys = await getApiKeys();
    if (!keys.length) throw new Error('API 키를 먼저 입력해주세요(한 줄에 하나씩 여러 개 가능).');
    const model = await getModel();
    const failures = [];
    let ok = 0;
    for (let i = 0; i < keys.length; i++) {
      try { await pingOnce(keys[i], model); ok++; } catch (e) { failures.push({ index: i, message: e.message }); }
    }
    if (ok === 0) throw new Error(`${keys.length}개 키 모두 연결 실패 (첫 번째 오류: ${failures[0].message})`);
    return { ok, total: keys.length, failures };
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
    getApiKey, setApiKey, getApiKeysText, setApiKeysText, getApiKeys,
    getModel, setModel, getUseGrounding, setUseGrounding,
    generateForQuestion, generateForChoice, testConnection,
    runBatch, openBatchModal,
  };
})();

window.AIExplain = AIExplain;
