/* tagger.js — 발문(설문) 텍스트만 보고 문제 유형을 추정하는 아주 단순한
 * 키워드 규칙 기반 분류기. 정답률을 보장하지 않으며, 어디까지나
 * "1차 추천"이고 사용자가 라이브러리 화면에서 자유롭게 수정할 수 있다.
 *
 * 새로운 시험(7급/입법고시/민경채 등)을 추가할 때는 RULES 객체에
 * 과목 키만 추가해주면 된다. 규칙은 위에서부터 순서대로 검사하며
 * 매치되는 것을 모두 태그로 추가한다(중복 가능, 최소 1개는 'unclassified').
 */

const Tagger = (() => {
  const RULES = {
    자료해석: [
      { tag: '보고서형', re: /보고서.*(부합|작성|내용)/ },
      { tag: '표-그림전환', re: /(그래프|그림).*(작성|옳지 않은|옳은)/ },
      { tag: '매칭형', re: /(A ?[~∼-] ?[A-Z]|바르게 연결)/ },
      { tag: '빈칸형', re: /\(\s*가\s*\)|\(\s*나\s*\)|빈칸/ },
      { tag: '조건판단형', re: /甲|乙|丙|정보>|조건/ },
      { tag: '단순확인형', re: /보기.*(옳은|옳지 않은).*고르면/ },
    ],
    언어논리: [
      { tag: '일치부합', re: /내용과 부합하는|알 수 있는|알 수 없는/ },
      { tag: '빈칸추론', re: /빈칸에 들어갈/ },
      { tag: '강화약화', re: /강화|약화/ },
      { tag: '논리퀴즈', re: /반드시 (참|거짓)인|전제로 적절한|이끌어내기 위하여/ },
      { tag: '문맥수정', re: /수정한 것으로|문맥에 맞게/ },
      { tag: '실험분석', re: /실험.*(결과|설명)/ },
      { tag: '글의구조', re: /핵심 논지|주장으로 가장 적절한/ },
    ],
    상황판단: [
      { tag: '법조문형', re: /제\s*[0○□△]+\s*조|다음 글을 근거로 판단할 때 옳은 것은/ },
      { tag: '계산형', re: /얼마인가|합은\?|최대|최소|비용은\?/ },
      { tag: '규칙적용형', re: /규칙에 따라|기준에 따라/ },
      { tag: '논리퀴즈', re: /甲|乙|丙|丁|戊/ },
      { tag: '날짜시간형', re: /요일|시각|소요되는|시간은/ },
    ],
  };

  /** subject: '자료해석' | '언어논리' | '상황판단' | 기타, stemText: 발문 일부 */
  function suggestTags(subject, stemText) {
    const text = (stemText || '').replace(/\s+/g, '');
    const rules = RULES[subject] || [];
    const tags = [];
    for (const r of rules) {
      if (r.re.test(text) || r.re.test(stemText || '')) tags.push(r.tag);
    }
    if (tags.length === 0) tags.push('미분류');
    return Array.from(new Set(tags));
  }

  function allKnownTags() {
    const set = new Set();
    Object.values(RULES).forEach((arr) => arr.forEach((r) => set.add(r.tag)));
    set.add('미분류');
    return Array.from(set);
  }

  return { suggestTags, allKnownTags, RULES };
})();

window.Tagger = Tagger;
