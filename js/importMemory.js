/* importMemory.js — "가져오기" 탭에서 사용자가 과목/시험유형을 직접
 * 입력·수정할 때마다 그 조합(과목명 → 시험유형)을 기억해두고, 나중에
 * 같은(또는 비슷한) 과목명이 자동 인식된 새 파일을 가져올 때 시험유형을
 * 자동으로 채워주는 기능.
 *
 * 저장 위치: IndexedDB의 `meta` 스토어(DB.setMeta/getMeta)에 키 하나
 * (`importAutoFillMemory`)로 저장. 이 스토어는 db.js의 exportAll/importAll
 * (전체 백업/복원, 설정 탭 "백업 파일 다운로드")에 이미 포함되어 있어
 * 전체 백업을 받으면 이 메모리도 자동으로 함께 백업/복원된다. 그와 별개로
 * 이 모듈 자체에 exportData/importData/resetAll을 노출해서, 설정 탭에서
 * "가져오기 자동완성 기억"만 따로 작은 파일로 백업/복원/초기화할 수도
 * 있게 한다(문제 이미지 데이터 없이 가벼운 파일).
 *
 * 자료구조:
 *   {
 *     bySubject: {
 *       [정규화된 과목명]: { subject: '원문 과목명', examType: '시험유형', updatedAt }
 *     },
 *     recentExamTypes: ['가장 최근 사용한 시험유형', ...] // 최대 MAX_RECENT개, 최신순
 *   }
 * `normalizeSubject`는 answerSheetImport.js의 동명 함수와 동일한 규칙
 * (공백/괄호 제거)을 써서, 표기가 살짝 다른 과목명도 매칭되게 한다.
 */

const ImportMemory = (() => {
  const META_KEY = 'importAutoFillMemory';
  const MAX_RECENT = 20;
  let cache = null; // 메모리 캐시(로드 후 재사용, 매번 IndexedDB 안 읽도록)

  function emptyMemory() {
    return { bySubject: {}, recentExamTypes: [] };
  }

  function normalizeSubject(s) {
    return String(s || '').replace(/\s+/g, '').replace(/[()（）]/g, '');
  }

  async function ensureLoaded() {
    if (cache) return cache;
    let saved = null;
    try {
      saved = await DB.getMeta(META_KEY);
    } catch (err) {
      console.error('가져오기 메모리 로드 실패', err);
    }
    cache = saved && typeof saved === 'object' ? { ...emptyMemory(), ...saved } : emptyMemory();
    if (!cache.bySubject || typeof cache.bySubject !== 'object') cache.bySubject = {};
    if (!Array.isArray(cache.recentExamTypes)) cache.recentExamTypes = [];
    return cache;
  }

  async function persist() {
    await DB.setMeta(META_KEY, cache);
  }

  /** 과목명+시험유형 조합을 기억(사용자가 두 칸을 모두 채운 상태에서
   * 시험유형 또는 과목 입력칸을 벗어날(blur) 때 호출됨). 둘 중 하나라도
   * 비어 있으면 아무것도 하지 않는다(불완전한 조합은 학습하지 않음). */
  async function record(subject, examType) {
    const subj = String(subject || '').trim();
    const type = String(examType || '').trim();
    if (!subj || !type) return;
    await ensureLoaded();
    const key = normalizeSubject(subj);
    if (!key) return;
    cache.bySubject[key] = { subject: subj, examType: type, updatedAt: Date.now() };
    cache.recentExamTypes = [type, ...cache.recentExamTypes.filter((t) => t !== type)].slice(0, MAX_RECENT);
    await persist();
  }

  /** 과목명으로 기억된 시험유형 조회. 정확히 일치하는 게 없으면 부분
   * 일치(포함 관계)로 폴백한다(정답표 자동인식의 과목 매칭과 같은 방식).
   * 반환: { subject, examType, updatedAt } | null */
  async function lookup(subject) {
    const subj = String(subject || '').trim();
    if (!subj) return null;
    await ensureLoaded();
    const key = normalizeSubject(subj);
    if (!key) return null;
    if (cache.bySubject[key]) return cache.bySubject[key];
    let best = null;
    for (const k of Object.keys(cache.bySubject)) {
      if (!k) continue;
      if (k.includes(key) || key.includes(k)) {
        const entry = cache.bySubject[k];
        if (!best || (entry.updatedAt || 0) > (best.updatedAt || 0)) best = entry;
      }
    }
    return best;
  }

  async function getRecentExamTypes() {
    await ensureLoaded();
    return cache.recentExamTypes.slice();
  }

  /** 설정 탭 등에서 "기억된 목록 보기"용 — 최근 수정순 정렬 */
  async function getAllSubjectEntries() {
    await ensureLoaded();
    return Object.values(cache.bySubject).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async function forgetSubject(subject) {
    await ensureLoaded();
    const key = normalizeSubject(subject);
    delete cache.bySubject[key];
    await persist();
  }

  async function resetAll() {
    cache = emptyMemory();
    await persist();
  }

  /** 이 메모리만 담은 작은 백업 객체(설정 탭 "메모리만 백업"용) */
  async function exportData() {
    await ensureLoaded();
    return { app: 'examBankImportMemory', version: 1, exportedAt: new Date().toISOString(), memory: cache };
  }

  /** exportData()로 만든 파일(또는 전체 백업의 data.meta[META_KEY])을 복원.
   * merge=true(기본)면 기존 기억과 합치고(같은 과목은 가져온 값으로 덮어씀),
   * merge=false면 기존 기억을 비우고 완전히 교체한다. 반환값: 복원된
   * 과목 수. */
  async function importData(data, { merge = true } = {}) {
    const incoming = (data && data.memory) || {};
    await ensureLoaded();
    if (!merge) cache = emptyMemory();
    cache.bySubject = { ...cache.bySubject, ...(incoming.bySubject || {}) };
    const incomingRecent = Array.isArray(incoming.recentExamTypes) ? incoming.recentExamTypes : [];
    cache.recentExamTypes = [...incomingRecent, ...cache.recentExamTypes]
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .slice(0, MAX_RECENT);
    await persist();
    return Object.keys(cache.bySubject).length;
  }

  return {
    record,
    lookup,
    getRecentExamTypes,
    getAllSubjectEntries,
    forgetSubject,
    resetAll,
    exportData,
    importData,
    normalizeSubject,
  };
})();

window.ImportMemory = ImportMemory;
