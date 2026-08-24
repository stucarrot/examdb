/* db.js — IndexedDB wrapper (v2)
 * 저장소 3개:
 *  - exams     : 문제지(시험) 단위 메타데이터 (시험유형/연도/과목/책형/제목/코드)
 *  - questions : 개별 문제 메타데이터. examId로 exams를 참조하며,
 *                검색/필터 속도를 위해 exam의 주요 필드를 함께 복사해 둔다(비정규화).
 *  - images    : 실제 문제 이미지(Blob). questions.imageIds 로 참조.
 *  - meta      : 앱 설정값 등 기타
 *
 * exam이 수정되면(시험유형/연도/과목/책형 변경) 그 exam에 속한 모든 question의
 * 캐시 필드와 code를 다시 계산해서 갱신한다 (DB.updateExam 참고).
 */

const DB_NAME = 'examBankDB';
const DB_VERSION = 3;
let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('exams')) {
        const es = db.createObjectStore('exams', { keyPath: 'id' });
        es.createIndex('code', 'code', { unique: false });
      }
      if (!db.objectStoreNames.contains('questions')) {
        const qs = db.createObjectStore('questions', { keyPath: 'id' });
        qs.createIndex('examId', 'examId', { unique: false });
        qs.createIndex('subject', 'subject', { unique: false });
      } else {
        const qs = req.transaction.objectStore('questions');
        if (!qs.indexNames.contains('examId')) qs.createIndex('examId', 'examId', { unique: false });
      }
      if (!db.objectStoreNames.contains('images')) {
        db.createObjectStore('images', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      // v3: 선지(choice) 단위 텍스트 추출 라이브러리. 문제(questions)와 별개로,
      // 텍스트 선지만 개별 저장해 태그/OX 체크/내보내기가 가능하게 한다.
      if (!db.objectStoreNames.contains('choices')) {
        const cs = db.createObjectStore('choices', { keyPath: 'id' });
        cs.createIndex('questionId', 'questionId', { unique: false });
        cs.createIndex('examId', 'examId', { unique: false });
        cs.createIndex('subject', 'subject', { unique: false });
      } else {
        const cs = req.transaction.objectStore('choices');
        if (!cs.indexNames.contains('questionId')) cs.createIndex('questionId', 'questionId', { unique: false });
        if (!cs.indexNames.contains('examId')) cs.createIndex('examId', 'examId', { unique: false });
        if (!cs.indexNames.contains('subject')) cs.createIndex('subject', 'subject', { unique: false });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
  return _dbPromise;
}

async function txStores(names, mode) {
  const db = await openDB();
  return db.transaction(names, mode);
}

function uid(prefix = 'q') {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
async function base64ToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

/** 시험/문제 명명 알고리즘 — 다른 모듈(importUI 등)에서도 재사용 */
const Naming = {
  /** 문제지(exam) 코드: 시험유형_연도_과목_책형 (값이 없는 항목은 생략) */
  examCode({ examType, year, subject, round }) {
    return [examType, year, subject, round].filter((v) => v && String(v).trim()).join('_');
  },
  /** 개별 문제 코드: 문제지코드_번호(2자리 이상) */
  questionCode(examCode, qnum) {
    return `${examCode}_${String(qnum).padStart(2, '0')}`;
  },
};

const DB = {
  uid,
  Naming,

  // ---------------- exams (문제지) ----------------

  async addExam(exam) {
    if (!exam.id) exam.id = uid('e');
    exam.code = Naming.examCode(exam);
    exam.createdAt = exam.createdAt || Date.now();
    const t = await txStores(['exams'], 'readwrite');
    t.objectStore('exams').put(exam);
    return new Promise((res, rej) => {
      t.oncomplete = () => res(exam);
      t.onerror = () => rej(t.error);
    });
  },

  async getExam(id) {
    const t = await txStores(['exams'], 'readonly');
    return new Promise((res, rej) => {
      const r = t.objectStore('exams').get(id);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },

  async getAllExams() {
    const t = await txStores(['exams'], 'readonly');
    return new Promise((res, rej) => {
      const r = t.objectStore('exams').getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  },

  /** exam 메타데이터 수정 + 소속 문제들의 캐시 필드/코드 일괄 재계산 */
  async updateExam(exam) {
    exam.code = Naming.examCode(exam);
    const t = await txStores(['exams', 'questions'], 'readwrite');
    t.objectStore('exams').put(exam);
    const qs = t.objectStore('questions');
    const idx = qs.index('examId');
    const cursorReq = idx.openCursor(IDBKeyRange.only(exam.id));
    await new Promise((res, rej) => {
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const q = cursor.value;
          q.examType = exam.examType;
          q.examYear = exam.year;
          q.subject = exam.subject;
          q.round = exam.round;
          q.examTitle = exam.title;
          q.code = Naming.questionCode(exam.code, q.qnum);
          cursor.update(q);
          cursor.continue();
        } else res();
      };
      cursorReq.onerror = () => rej(cursorReq.error);
    });
    return new Promise((res, rej) => {
      t.oncomplete = () => res(exam);
      t.onerror = () => rej(t.error);
    });
  },

  /** 문제지 삭제 (소속 문제/이미지 전부 삭제) */
  async deleteExam(examId) {
    const qs = await this.getQuestionsByExam(examId);
    await this.deleteQuestions(qs.map((q) => q.id));
    const t = await txStores(['exams'], 'readwrite');
    t.objectStore('exams').delete(examId);
    return new Promise((res, rej) => {
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
  },

  async getQuestionsByExam(examId) {
    const t = await txStores(['questions'], 'readonly');
    return new Promise((res, rej) => {
      const idx = t.objectStore('questions').index('examId');
      const r = idx.getAll(IDBKeyRange.only(examId));
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  },

  // ---------------- questions (개별 문제) ----------------

  /** question: 메타데이터 객체(이미 id, examId 포함), imageBlobs: Blob[] (순서대로 조각 1,2,...) */
  async addQuestion(question, imageBlobs) {
    if (!question.id) question.id = uid('q');
    const t = await txStores(['questions', 'images'], 'readwrite');
    const qs = t.objectStore('questions');
    const is = t.objectStore('images');
    question.imageIds = [];
    (imageBlobs || []).forEach((blob, idx) => {
      const imgId = question.id + '_img' + idx;
      is.put({ id: imgId, blob });
      question.imageIds.push(imgId);
    });
    qs.put(question);
    return new Promise((res, rej) => {
      t.oncomplete = () => res(question);
      t.onerror = () => rej(t.error);
    });
  },

  async updateQuestion(question) {
    const t = await txStores(['questions'], 'readwrite');
    t.objectStore('questions').put(question);
    return new Promise((res, rej) => {
      t.oncomplete = () => res(question);
      t.onerror = () => rej(t.error);
    });
  },

  async deleteQuestions(ids) {
    const t = await txStores(['questions', 'images', 'choices'], 'readwrite');
    const qs = t.objectStore('questions');
    const is = t.objectStore('images');
    const cs = t.objectStore('choices');
    const cIdx = cs.index('questionId');
    for (const id of ids) {
      const getReq = qs.get(id);
      await new Promise((res) => {
        getReq.onsuccess = () => {
          const q = getReq.result;
          if (q) (q.imageIds || []).forEach((imgId) => is.delete(imgId));
          qs.delete(id);
          res();
        };
        getReq.onerror = () => res();
      });
      // 이 문제에서 추출해둔 선지(choices)도 함께 정리한다(고아 레코드 방지).
      await new Promise((res) => {
        const cReq = cIdx.openCursor(IDBKeyRange.only(id));
        cReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) { cursor.delete(); cursor.continue(); } else res();
        };
        cReq.onerror = () => res();
      });
    }
    return new Promise((res, rej) => {
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
  },

  async getQuestion(id) {
    const t = await txStores(['questions'], 'readonly');
    return new Promise((res, rej) => {
      const r = t.objectStore('questions').get(id);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },

  async getAllQuestions() {
    const t = await txStores(['questions'], 'readonly');
    return new Promise((res, rej) => {
      const r = t.objectStore('questions').getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  },

  async getImageBlob(imgId) {
    const t = await txStores(['images'], 'readonly');
    return new Promise((res, rej) => {
      const r = t.objectStore('images').get(imgId);
      r.onsuccess = () => res(r.result ? r.result.blob : null);
      r.onerror = () => rej(r.error);
    });
  },

  /** 문제 하나의 전체 해상도 이미지 Blob 배열(조각 순서대로) */
  async getImageBlobs(question) {
    const blobs = [];
    for (const id of question.imageIds || []) {
      blobs.push(await this.getImageBlob(id));
    }
    return blobs.filter(Boolean);
  },

  /** 화면 표시용 objectURL 배열 (사용 후 반드시 revokeObjectURL 호출 권장) */
  async getImageURLs(question) {
    const blobs = await this.getImageBlobs(question);
    return blobs.map((b) => URL.createObjectURL(b));
  },

  // ---------------- choices (문제에서 추출한 개별 선지 텍스트) ----------------

  async addChoice(choice) {
    if (!choice.id) choice.id = uid('c');
    choice.createdAt = choice.createdAt || Date.now();
    const t = await txStores(['choices'], 'readwrite');
    t.objectStore('choices').put(choice);
    return new Promise((res, rej) => {
      t.oncomplete = () => res(choice);
      t.onerror = () => rej(t.error);
    });
  },

  /** 선지 여러 개를 한 트랜잭션으로 일괄 저장(가져오기 시 사용) */
  async addChoices(choices) {
    if (!choices || !choices.length) return [];
    const t = await txStores(['choices'], 'readwrite');
    const store = t.objectStore('choices');
    choices.forEach((c) => {
      if (!c.id) c.id = uid('c');
      c.createdAt = c.createdAt || Date.now();
      store.put(c);
    });
    return new Promise((res, rej) => {
      t.oncomplete = () => res(choices);
      t.onerror = () => rej(t.error);
    });
  },

  async updateChoice(choice) {
    const t = await txStores(['choices'], 'readwrite');
    t.objectStore('choices').put(choice);
    return new Promise((res, rej) => {
      t.oncomplete = () => res(choice);
      t.onerror = () => rej(t.error);
    });
  },

  async getChoice(id) {
    const t = await txStores(['choices'], 'readonly');
    return new Promise((res, rej) => {
      const r = t.objectStore('choices').get(id);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },

  async getAllChoices() {
    const t = await txStores(['choices'], 'readonly');
    return new Promise((res, rej) => {
      const r = t.objectStore('choices').getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  },

  async getChoicesByQuestion(questionId) {
    const t = await txStores(['choices'], 'readonly');
    return new Promise((res, rej) => {
      const idx = t.objectStore('choices').index('questionId');
      const r = idx.getAll(IDBKeyRange.only(questionId));
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  },

  async deleteChoices(ids) {
    const t = await txStores(['choices'], 'readwrite');
    const store = t.objectStore('choices');
    for (const id of ids) store.delete(id);
    return new Promise((res, rej) => {
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
  },

  async setMeta(key, value) {
    const t = await txStores(['meta'], 'readwrite');
    t.objectStore('meta').put({ key, value });
    return new Promise((res, rej) => {
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
  },
  async getMeta(key) {
    const t = await txStores(['meta'], 'readonly');
    return new Promise((res, rej) => {
      const r = t.objectStore('meta').get(key);
      r.onsuccess = () => res(r.result ? r.result.value : null);
      r.onerror = () => rej(r.error);
    });
  },
  /** meta 스토어 전체를 {key: value} 형태로 덤프 (백업용) */
  async getAllMeta() {
    const t = await txStores(['meta'], 'readonly');
    return new Promise((res, rej) => {
      const r = t.objectStore('meta').getAll();
      r.onsuccess = () => {
        const out = {};
        (r.result || []).forEach((row) => { out[row.key] = row.value; });
        res(out);
      };
      r.onerror = () => rej(r.error);
    });
  },
  /** meta 스토어 일괄 복원. merge=false면 기존 meta를 먼저 비운다. */
  async setAllMeta(obj, { merge = true } = {}) {
    const t = await txStores(['meta'], 'readwrite');
    const store = t.objectStore('meta');
    if (!merge) store.clear();
    Object.entries(obj || {}).forEach(([key, value]) => store.put({ key, value }));
    return new Promise((res, rej) => {
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
  },

  // ---------------- 백업 / 복원 ----------------

  /** 전체 백업(JSON, base64 이미지 포함) */
  async exportAll(onProgress) {
    const exams = await this.getAllExams();
    const questions = await this.getAllQuestions();
    const choices = await this.getAllChoices();
    const meta = await this.getAllMeta();
    const out = [];
    let i = 0;
    for (const q of questions) {
      const blobs = await this.getImageBlobs(q);
      const imagesB64 = [];
      for (const b of blobs) imagesB64.push(await blobToBase64(b));
      const clean = { ...q };
      delete clean.imageIds;
      out.push({ ...clean, imagesB64 });
      i++;
      if (onProgress) onProgress(i, questions.length);
    }
    return { app: 'examBank', version: 3, exportedAt: new Date().toISOString(), exams, questions: out, choices, meta };
  },

  /** 백업 복원. merge=false 면 기존 데이터 전부 삭제 후 복원 */
  async importAll(data, { merge = true, onProgress } = {}) {
    if (!merge) await this.clearAll();

    const exams = (data && data.exams) || [];
    for (const ex of exams) {
      const t = await txStores(['exams'], 'readwrite');
      t.objectStore('exams').put(ex);
      await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
    }

    const list = (data && data.questions) || [];
    let i = 0;
    for (const q of list) {
      const blobs = [];
      for (const b64 of q.imagesB64 || []) blobs.push(await base64ToBlob(b64));
      const clean = { ...q };
      delete clean.imagesB64;
      delete clean.imageIds;
      if (!clean.id) clean.id = uid('q');
      await this.addQuestion(clean, blobs);
      i++;
      if (onProgress) onProgress(i, list.length);
    }

    // 선지(choices) 백업 복원 — v3 이전 백업 파일에는 이 필드가 없을 수 있으므로 없으면 건너뜀.
    const choiceList = (data && data.choices) || [];
    for (const c of choiceList) {
      const clean = { ...c };
      if (!clean.id) clean.id = uid('c');
      await this.addChoice(clean);
    }

    // meta(가져오기 자동완성 기억 등 내부 설정)도 함께 있으면 복원한다.
    // merge=false로 전체 교체한 경우엔 clearAll()이 exams/questions/images만
    // 비웠으므로, 여기서도 같은 merge 플래그로 meta를 통일성 있게 처리한다.
    if (data && data.meta) {
      await this.setAllMeta(data.meta, { merge });
    }

    return list.length;
  },

  async clearAll() {
    const t = await txStores(['exams', 'questions', 'images', 'choices'], 'readwrite');
    t.objectStore('exams').clear();
    t.objectStore('questions').clear();
    t.objectStore('images').clear();
    t.objectStore('choices').clear();
    return new Promise((res, rej) => {
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
  },
};

window.DB = DB;
