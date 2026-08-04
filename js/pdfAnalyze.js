/* pdfAnalyze.js — PDF를 페이지별로 렌더링하고, 문제 번호(1. 2. 3. ...)의
 * 위치를 텍스트 레이어에서 찾아 자동으로 문제 영역(박스)을 추정한다.
 *
 * 핵심 아이디어(휴리스틱):
 *  1) 시험 문제는 "1." "2." "3." ... 처럼(또는 "문 1." "문 2." ... 처럼,
 *     "문"과 번호 사이 공백 1개 이상) 번호가 항상 1씩 순차 증가한다. 문제 수
 *     + 1 과 정확히 일치하면서, 컬럼 좌측 정렬 영역에서 시작하는 "숫자+마침표"
 *     줄만 새 문제의 시작으로 인정한다(표 안 우연한 숫자 오탐 방지).
 *  2) 좌/우 2단 편집을 기본 가정하고, 컬럼별로 줄을 묶은 뒤(컬럼을 먼저 나누고
 *     그 안에서만 y좌표로 줄을 묶어야 좌우 텍스트가 한 줄로 섞이지 않는다),
 *     왼쪽 컬럼 전체 → 오른쪽 컬럼 전체 순서로(실제 읽는 순서) 번호를 찾는다.
 *  3) 문제의 "끝"은 텍스트가 아니라 **렌더링된 캔버스의 실제 픽셀**을 위에서
 *     아래로 훑어서 판단한다. 흰 배경이 아닌("잉크가 있는") 행이 어디까지
 *     이어지는지 보고, 줄 높이의 약 2배 이상 흰 여백이 연속되는 지점을
 *     만나면 그 직전을 문제의 끝으로 본다. 텍스트가 전혀 없는 그래프/표
 *     여백(예: 선택지 자체가 차트인 문제, 마지막 선택지 아래로 축 라벨이
 *     이어지는 경우)도 텍스트 레이어와 무관하게 잡아낼 수 있다.
 *  3-0) 단, "마지막 선택지가 이미 등장한 뒤에 나온 여백"만 진짜 끝으로
 *     인정한다. 표와 <보기> 사이처럼 아직 선택지가 나오기도 전에 우연히
 *     큰 여백이 있는 경우를, 그 여백만 보고 "끝났다"고 오인식하는 것을
 *     막기 위함이다(텍스트 기반 게이트 + 픽셀 기반 위치 판정의 조합).
 *     "마지막 선택지"는 문서 전체를 가볍게 훑어 ④(4지선다, 예: 7급공채
 *     2차)인지 ⑤(5지선다, 예: 5급공채/PSAT류)인지 자동 판단한다.
 *  3-1) 만약 그런 "충분히 큰 흰 여백"을 다음 문제 시작(또는 컬럼 하단)까지
 *     끝내 못 찾으면, 이 문제가 다음 컬럼/페이지로 넘어간다고 판단한다
 *     (4번 참고).
 *  4) 어떤 컬럼의 마지막 문제인데 그 컬럼 안에서 마지막 선택지를 못 찾으면,
 *     그 문제가 다음 컬럼(또는 다음 페이지 첫 컬럼)까지 이어진다고 보고
 *     이어지는 부분을 별도 조각(part)으로 캡처한다. 같은 문제번호를 공유하는
 *     조각들은 저장 시 자동으로 합쳐지며, 이런 "컬럼/페이지 넘김" 조각은
 *     라이브러리에서 가로로 나란히 보여준다(세트문제 공통 지문은 세로로
 *     쌓아서 보여줌).
 *  5) "[30 ~ 31]" 같은 대괄호 범위 표기를 세트문제 공통 지문의 시작으로 보고,
 *     그 표기부터 세트의 첫 번째 문제 번호가 시작되기 전까지를 "세트 공통
 *     박스"로 잡는다. 저장 시 이 공통 박스는 세트에 속한 모든 문제의 첫 번째
 *     조각으로 복사되어 들어간다.
 *
 * 100% 정확하지는 않으므로, 리뷰 화면에서 박스를 手動으로 추가/삭제/이동/
 * 리사이즈 할 수 있게 되어 있다.
 */

const PDFAnalyze = (() => {
  function setupWorker() {
    if (window.pdfjsLib && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
  }

  /**
   * 문서 전체 페이지의 텍스트 레이어만(렌더링 없이) 훑어서 "⑤"가 한 번이라도
   * 등장하는지 확인한다. 등장하면 5지선다 시험(⑤가 마지막 선택지), 등장하지
   * 않으면 4지선다 시험(7급공채 2차 등, ④가 마지막 선택지)으로 판단한다.
   */
  async function detectLastChoiceMarker(pdf) {
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      for (const it of tc.items) {
        if (it.str && it.str.includes('⑤')) return '⑤';
      }
    }
    return '④';
  }

  /**
   * @param {File} file
   * @param {Object} opts { scale, twoColumn, startQnum, headerRatio, footerRatio, onPage }
   * @returns {Promise<{pages, boxes, lastQnum}>}
   *   boxes: 일반 문제 조각 {id,pageIndex,x,y,w,h,qnum,isOverflowPart,partIndex,stemText}
   *          또는 세트 공통 조각 {id,pageIndex,x,y,w,h,kind:'setIntro',setRange:[a,b]}
   */
  async function analyze(file, opts = {}) {
    setupWorker();
    const scale = opts.scale || 1.8;
    const twoColumn = opts.twoColumn !== false;
    const headerRatio = opts.headerRatio ?? 0.06;
    const footerRatio = opts.footerRatio ?? 0.025;
    const gapLines = opts.contentGapLines ?? 2.2; // 이 줄수 이상 흰 여백이 이어지면 "진짜 끝"으로 판단
    let expectedNum = opts.startQnum || 1;

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    // 선택지가 4개(①~④, 예: 7급공채 2차)인지 5개(①~⑤, 예: 5급공채/PSAT류)인지
    // 렌더링 없이 텍스트만 가볍게 훑어 문서 전체에서 한 번만 판단한다. 문제
    // "끝"을 픽셀로 판정할 때, 마지막 선택지가 이미 나온 뒤의 여백만 진짜
    // 끝으로 인정하는 게이트에 사용한다(아래 findContentEnd 참고). 4지선다
    // 문서에서 계속 ⑤를 찾으려 하면 게이트가 영영 안 열려 모든 컬럼의
    // 마지막 문제가 "안 끝남(overflow)"으로 오판되어 인식이 어긋난다.
    const lastChoiceChar = await detectLastChoiceMarker(pdf);

    const pages = [];
    const allBoxes = [];

    // 컬럼(단)을 넘어가며 유지해야 하는 상태: 아직 마지막 선택지(끝)를 못 찾은 문제
    let pendingContinuation = null; // { qnum, partIndex }
    let continuationHops = 0;
    const MAX_CONTINUATION_HOPS = 5;

    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;

      const textContent = await page.getTextContent();
      // 주의: str이 공백(" ") 하나뿐인 아이템을 여기서 걸러내면 안 된다.
      // 이 앱이 다루는 정부 시험 PDF 상당수는 한글 워드프로세서(HWP) 변환
      // 특성상 글자 하나하나(공백 포함)가 각각 별도의 텍스트 아이템으로
      // 배치되어 있다("문", " ", "1.", " ", "소득분배와..." 식). 아래
      // buildLines()는 같은 줄의 아이템들을 str만 이어붙여(join('')) 줄
      // 텍스트를 만드는데, 공백 전용 아이템까지 걸러버리면 "문 1."이
      // "문1."로 붙어버려 "문(공백)번호." 형식 문제 번호를 통째로 못 찾게
      // 된다(실사용 중 발견된 실제 버그). 완전히 빈 문자열(마킹 콘텐츠 등)만
      // 제거하고, 공백 문자로만 이루어진 아이템은 그대로 남긴다.
      const rawItems = textContent.items.map((it) => {
        const [vx, vy] = viewport.convertToViewportPoint(it.transform[4], it.transform[5]);
        return { str: it.str, x: vx, y: vy };
      }).filter((it) => it.str && it.str.length > 0);

      const pageWidth = viewport.width;
      const pageHeight = viewport.height;
      const midX = pageWidth / 2;
      const headerLimit = pageHeight * headerRatio;
      // 컬럼의 "진짜 마지막 문제"를 판정/크롭할 때 쓰는 하단 경계. 실제
      // 마지막 줄이 페이지 물리적 하단에 거의 붙어서 끝나는 경우가 흔한데,
      // 예전엔 footerRatio 전체를 안전지대로 통째로 비워뒀더니 (a) 잉크
      // 스캔 자체가 거기서 끊겨서 마지막 줄 일부를 놓치고, (b) 하단 패딩을
      // 더해도 그 경계로 다시 깎여서 패딩이 무의미해지는 문제가 있었다.
      // footerRatio로 reserve해둔 여백의 앞 60%만 진짜 꼬리말/페이지번호를
      // 위한 안전지대로 남기고, 나머지 40%는 마지막 문제 판정/크롭에 쓴다.
      const hardBottomY = pageHeight * (1 - footerRatio * 0.6);

      const colItems = { 0: [], 1: [] };
      rawItems.forEach((it) => {
        if (it.y < headerLimit) return;
        const col = twoColumn ? (it.x < midX ? 0 : 1) : 0;
        colItems[col].push(it);
      });

      function buildLines(itemsInCol) {
        const arr = itemsInCol.slice().sort((a, b) => a.y - b.y || a.x - b.x);
        const yTol = 4;
        const lns = [];
        for (const it of arr) {
          let line = lns.find((l) => Math.abs(l.y - it.y) <= yTol);
          if (!line) { line = { y: it.y, items: [] }; lns.push(line); }
          line.items.push(it);
        }
        lns.forEach((l) => l.items.sort((a, b) => a.x - b.x));
        lns.sort((a, b) => a.y - b.y);
        // x0: 그 줄에서 가장 왼쪽 아이템의 x좌표(문제 번호 줄 판별 시 "컬럼 좌측
        // 정렬 여부"를 확인하는 용도 — 표 안에 우연히 있는 숫자는 보통 컬럼
        // 좌측 끝에서 시작하지 않으므로 오탐 방지에 쓴다).
        return lns.map((l) => ({
          y: l.y,
          text: l.items.map((i) => i.str).join(''),
          x0: l.items.length ? l.items[0].x : 0,
        }));
      }

      const colLines = { 0: buildLines(colItems[0]), 1: twoColumn ? buildLines(colItems[1]) : [] };

      pages.push({ pageIndex: p - 1, canvas, width: canvas.width, height: canvas.height });

      const cols = twoColumn ? [0, 1] : [0];
      for (const col of cols) {
        const xStart = col === 0 ? pageWidth * 0.025 : midX + pageWidth * 0.01;
        const xEnd = col === 0 ? (twoColumn ? midX - pageWidth * 0.01 : pageWidth * 0.975) : pageWidth * 0.975;
        const lines = colLines[col];
        const lineH = estimateLineHeight(lines);
        // 박스 상/하단 여유. 폰트나 글자 크기에 따라 어센더(위로 튀어나온
        // 부분, 예: ㄱ/ㅎ 받침이나 대문자)나 하강 획이 줄 높이의 절반보다
        // 더 튀어나오는 경우가 있어서, 위쪽은 줄 높이의 절반보다 넉넉하게,
        // 아래쪽도 약간의 여유를 둔다(단, 다음 문제 박스와 겹치지 않도록
        // upperBound를 넘지 않게 클램프한다 — 아래 참고).
        const topPad = lineH * 0.85;
        const bottomPad = lineH * 0.3;
        const gapPx = lineH * gapLines;
        // 컬럼 하단(=꼬리말 직전 인위적 경계)까지 도달한 경우는, 그 아래로도
        // 실제 여백이 더 있을 게 뻔하므로(꼬리말 제외 영역) 더 관대한 기준을
        // 적용한다. 그래야 "문제가 컬럼 끝부분에서 딱 끝났는데 측정 가능한
        // 범위 안에서는 여백이 2.2줄이 안 돼서 안 끝난 걸로 오판"하는 걸 막는다.
        const gapPxLenient = lineH * Math.min(gapLines, 0.9);

        // 이 컬럼의 "잉크가 있는 행" 프로파일을 한 번만 계산해서 재사용한다.
        // hardBottomY까지 스캔해서, 마지막 문제 판정/크롭에 그 여분 구간의
        // 실제 잉크 정보도 쓸 수 있게 한다.
        const inkProfile = computeInkRows(ctx, xStart, xEnd, headerLimit, hardBottomY);

        // 문제 시작 지점과 세트 마커("[30~31]" 등)를 찾는다
        const boundaries = []; // {y, qnum}
        const setMarkers = []; // {y, range:[a,b]}
        // 문제 번호 줄이 시작될 수 있는 x범위(컬럼 좌측 약 25% 이내). 표
        // 안에 우연히 있는 숫자는 보통 이보다 안쪽(들여쓰기 된 곳)에서
        // 시작하므로 오탐 방지에 쓴다.
        const numGateX = xStart + (xEnd - xStart) * 0.25;
        for (const line of lines) {
          const setM = line.text.match(/\[\s*(\d{1,3})\s*[~∼～\-]\s*(\d{1,3})\s*\]/);
          if (setM) setMarkers.push({ y: line.y, range: [parseInt(setM[1], 10), parseInt(setM[2], 10)] });

          // 문제 번호 줄은 "N."(5급공채 등) 또는 "문 N."(7급공채 등, "문"과
          // 번호 사이에 공백 1개 이상) 두 형식을 모두 지원한다. 번호 바로
          // 뒤에 오는 문자는 더 이상 제한하지 않는다 — 예전엔 [가-힣<(]로
          // 좁게 제한했었는데, 甲/乙 같은 한자나 사설 글리프(X재의 X 등),
          // "IS-LM..."처럼 영문으로 시작하는 문제가 이 제한에 걸려 인식이
          // 안 됐고, expectedNum 순차 검증 특성상 그 문제 하나만 놓치는 게
          // 아니라 그 뒤 모든 문제가 연쇄적으로 인식 안 되는 심각한 버그로
          // 이어졌다. 대신 (a) 소수점(예: "12.5")과의 혼동을 막기 위해 바로
          // 뒤에 숫자가 오면 제외하고, (b) 표 안 숫자 오탐 방지는 위
          // numGateX(좌측 정렬 여부) 검사로 대체했다.
          const numM = line.text.match(/^\s*(?:문\s+)?(\d{1,3})\s*\.(?!\d)/);
          if (numM && line.x0 <= numGateX) {
            const num = parseInt(numM[1], 10);
            if (num === expectedNum) {
              boundaries.push({ y: line.y, qnum: num });
              expectedNum++;
            }
          }
        }

        const stemTextFor = (y1, y2) => {
          const stemLimit = y1 + (y2 - y1) * 0.35;
          return lines.filter((l) => l.y >= y1 && l.y <= stemLimit).map((l) => l.text).join(' ').slice(0, 200);
        };

        // 이 컬럼에서 "마지막 선택지"(lastChoiceChar: 4지선다면 ④, 5지선다면
        // ⑤)가 포함된 줄들의 y좌표 (텍스트 기반 게이트용)
        const lastMarkerYs = lines.filter((l) => l.text.includes(lastChoiceChar)).map((l) => l.y);

        // 픽셀 기준 종료 지점 판정: [y1, upperBound) 구간을 위→아래로 훑어
        // gapPx 이상 흰 여백이 이어지는 지점을 찾되, **마지막 선택지가
        // 그 전에 이미 나온 경우에만** 그 여백을 "진짜 끝"으로 인정한다.
        // (표와 <보기> 사이처럼, 아직 선택지가 나오기도 전에 우연히 큰
        // 여백이 있는 경우를 "끝"으로 오인식하지 않기 위한 안전장치.
        // 마지막 선택지 이후 등장하는 그래프/표의 여백은 여전히 픽셀
        // 스캔으로 판단하므로, 선택지 라벨 자체가 잘리는 문제는 발생하지
        // 않는다.)
        const findContentEnd = (y1, upperBound, isColumnBottom) => {
          const markerYsInRange = lastMarkerYs.filter((y) => y >= y1 && y < upperBound);
          return findContentEndPx(inkProfile, y1, upperBound, isColumnBottom ? gapPxLenient : gapPx, markerYsInRange);
        };

        // (A) 이전 컬럼에서 끝나지 못한 문제가 있으면, 이 컬럼 맨 위부터
        //     이어지는 조각으로 캡처한다. 이때도 일반 문제박스와 동일하게,
        //     이 컬럼의 첫 줄이 잘리지 않도록 반 줄만큼 위쪽 여유를 둔다.
        if (pendingContinuation) {
          const firstLineInCol = lines.find((l) => l.y >= headerLimit);
          const contStart = firstLineInCol ? Math.max(0, firstLineInCol.y - topPad) : headerLimit;
          const isColBottom = boundaries.length === 0;
          const upperBound = boundaries.length ? boundaries[0].y - topPad : hardBottomY;
          const { end, hadGap, sawInk } = findContentEnd(contStart, upperBound, isColBottom);

          if (!sawInk) {
            // 이 컬럼에 이어지는 내용이 실제로 하나도 없다 → 앞서 "넘어감"
            // 판정이 잘못됐던 것이었다. 이게 첫 번째(=바로 다음 컬럼)
            // 확인이었다면(partIndex===2), 원래 박스가 사실은 끝까지 온전한
            // 문제였다는 뜻이므로 "조각" 표시를 지우고, 그 컬럼 안에서
            // 실제로 마지막까지 잉크가 있었던 지점(fallbackEnd)까지로 높이를
            // 다시 맞춘다(그래야 문제 다 끝난 뒤의 빈 여백까지 박스에 딸려
            // 들어가지 않는다). 두 번째 이후 hop이 비어있는 건 정상적인
            // "여러 조각짜리 문제가 여기서 끝났다"는 뜻이라 손대지 않는다.
            if (pendingContinuation.partIndex === 2 && pendingContinuation.sourceBox) {
              const srcBox = pendingContinuation.sourceBox;
              srcBox.isOverflowPart = false;
              if (typeof pendingContinuation.fallbackEnd === 'number') {
                const maxY2 = srcBox.y + srcBox.h; // 원래 hardBottomY까지였던 하한
                const newY2 = Math.min(pendingContinuation.fallbackEnd + (pendingContinuation.bottomPad || 0), maxY2);
                srcBox.h = Math.max(20, newY2 - srcBox.y);
              }
            }
            pendingContinuation = null;
            continuationHops = 0;
          } else {
            // hadGap일 때 실제 검출된 끝 지점 바로 아래로 살짝 여유를 더 준다
            // (하강 획이나 마지막 줄 다음 여백이 빠듯해 보이지 않도록). 단,
            // 다음 문제 박스의 시작(upperBound)을 넘어서면 안 되므로 클램프.
            const y2 = hadGap ? Math.min(end + bottomPad, upperBound) : upperBound;
            allBoxes.push({
              id: 'cont' + (p - 1) + '_' + col + '_' + pendingContinuation.qnum + '_' + pendingContinuation.partIndex,
              pageIndex: p - 1,
              x: xStart, y: contStart, w: xEnd - xStart, h: Math.max(20, y2 - contStart),
              qnum: pendingContinuation.qnum,
              isOverflowPart: true,
              partIndex: pendingContinuation.partIndex,
              stemText: '',
            });
            if (hadGap || boundaries.length > 0) {
              pendingContinuation = null;
              continuationHops = 0;
            } else if (continuationHops < MAX_CONTINUATION_HOPS) {
              pendingContinuation = { qnum: pendingContinuation.qnum, partIndex: pendingContinuation.partIndex + 1 };
              continuationHops++;
            } else {
              pendingContinuation = null;
              continuationHops = 0;
            }
          }
        }

        // (B) 이 컬럼에서 새로 시작하는 문제들의 박스를 만든다
        for (let i = 0; i < boundaries.length; i++) {
          const y1 = Math.max(0, boundaries[i].y - topPad);
          const isLastInCol = i + 1 >= boundaries.length;
          const upperBound = isLastInCol ? hardBottomY : boundaries[i + 1].y - topPad;
          const { end, hadGap } = findContentEnd(y1, upperBound, isLastInCol);
          let y2;
          let overflow = false;
          if (hadGap) {
            // 실제 검출된 끝 지점 바로 아래로 살짝 여유를 더 준다(하강 획이나
            // 선택지 마지막 줄이 박스 경계에 바짝 붙어 보이지 않도록). 단,
            // 다음 문제 박스의 시작(upperBound)을 넘어서면 안 되므로 클램프.
            y2 = Math.min(end + bottomPad, upperBound);
          } else if (!isLastInCol) {
            // 다음 문제 번호가 바로 이어서 시작됐다면(=텍스트상 새 경계가 있다면)
            // 여백을 못 찾았어도 그 경계에서 자른다(예외적 상황에 대한 방어)
            y2 = upperBound;
          } else {
            // 컬럼의 마지막 문제인데 끝까지 내용이 이어짐 → 다음 컬럼/페이지로 넘어감
            y2 = hardBottomY;
            overflow = true;
          }

          const box = {
            id: 'b' + (p - 1) + '_' + col + '_' + i,
            pageIndex: p - 1,
            x: xStart, y: y1, w: xEnd - xStart, h: Math.max(20, y2 - y1),
            qnum: boundaries[i].qnum,
            isOverflowPart: overflow,
            partIndex: 1,
            stemText: stemTextFor(y1, y2),
          };
          allBoxes.push(box);

          if (overflow) {
            // "다음 컬럼으로 넘어간다"는 판정이 실제로는 틀릴 수 있다 — 이
            // 컬럼의 마지막 문제가 페이지/컬럼 맨 아래에 딱 붙어서 끝나
            // 여백(gap)을 확정할 만큼의 공간이 없었을 뿐, 사실은 이미
            // 내용이 다 끝난 경우다. 다음 컬럼에서 실제로 이어지는 내용이
            // 하나도 없는 걸로 확인되면(아래 (A) 블록의 `!sawInk` 분기)
            // 이 박스를 "조각"이 아닌 일반 박스로 되돌려야 하므로, 박스
            // 참조와 "이 컬럼 안에서 실제로 잉크가 있었던 마지막 지점"을
            // 같이 들고 있는다.
            pendingContinuation = {
              qnum: boundaries[i].qnum,
              partIndex: 2,
              sourceBox: box,
              fallbackEnd: end,
              bottomPad, // 컬럼 스코프를 벗어난 뒤(문서 끝 정리)에도 같은 패딩값을 쓰기 위해 같이 들고 있는다
            };
            continuationHops = 1;
          }
        }

        // (C) 세트문제 공통 박스: "[a~b]" 표기부터 첫 멤버(a번) 시작 전까지
        for (const sm of setMarkers) {
          const firstMemberBoundary = boundaries.find((b) => b.qnum === sm.range[0]);
          if (!firstMemberBoundary) continue;
          const y1 = Math.max(0, sm.y - topPad);
          const y2 = Math.max(y1 + 20, firstMemberBoundary.y - topPad);
          allBoxes.push({
            id: 'set' + (p - 1) + '_' + col + '_' + sm.range.join('-'),
            pageIndex: p - 1,
            x: xStart, y: y1, w: xEnd - xStart, h: y2 - y1,
            kind: 'setIntro',
            setRange: sm.range,
          });
        }
      }

      if (opts.onPage) opts.onPage(p, pdf.numPages);
    }

    // 문서 전체를 다 훑었는데도 아직 pendingContinuation이 남아있다면(=마지막
    // 페이지의 마지막 컬럼에서 "다음 컬럼으로 넘어감"으로 판단된 문제),
    // 더 이상 확인할 다음 컬럼/페이지가 없다. 즉 확실히 "안 넘어가는"
    // 문제였다는 뜻이므로, 컬럼 넘어갈 때(!sawInk 분기)와 똑같은 방식으로
    // 원본 박스의 "조각" 표시를 되돌리고 높이도 다시 맞춘다. (partIndex가
    // 2보다 크다면 이미 실제 넘김 조각들이 만들어진 뒤라 문서가 거기서
    // 그냥 끝난 것뿐이므로 손대지 않는다.)
    if (pendingContinuation && pendingContinuation.partIndex === 2 && pendingContinuation.sourceBox) {
      const srcBox = pendingContinuation.sourceBox;
      srcBox.isOverflowPart = false;
      if (typeof pendingContinuation.fallbackEnd === 'number') {
        const maxY2 = srcBox.y + srcBox.h;
        const newY2 = Math.min(pendingContinuation.fallbackEnd + (pendingContinuation.bottomPad || 0), maxY2);
        srcBox.h = Math.max(20, newY2 - srcBox.y);
      }
    }

    return { pages, boxes: allBoxes, lastQnum: expectedNum - 1 };
  }

  /**
   * PDF 1페이지(필요하면 2페이지까지)의 머리말(맨 위)과 꼬리말(맨 아래)
   * 텍스트에서 시험명/연도/과목/책형을 추정한다. (전체 분석 전에 폼을
   * 미리 채워주기 위한 용도)
   *
   * 우선순위: 1페이지 머리말 → 1페이지 꼬리말 → (그래도 부족하면) 2페이지
   * 머리말/꼬리말 → (그래도 부족하면) 파일명에서 추정. 시험마다 표지 구성이
   * 달라서(예: 정보가 머리말이 아니라 꼬리말에만 있거나, 1페이지가 속표지라
   * 실제 인쇄 정보는 2페이지부터 시작) 어느 한쪽만 보면 놓치는 경우가 있어
   * 이렇게 여러 군데를 순서대로 훑고, 각 필드는 처음 찾은 값을 채택한다.
   */
  async function detectHeader(file, opts = {}) {
    setupWorker();
    const scale = opts.scale || 1.5;
    const headerRatio = opts.headerRatio ?? 0.06;
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    const FIELD_KEYS = ['year', 'title', 'subject', 'round', 'examType'];

    function extractFrom(text) {
      const yearMatch = text.match(/(\d{4})\s*년도/);
      const titleMatch = text.match(/(\d{4}\s*년도[^|]*?(?:필기시험|시험))/);
      // 5급공채/PSAT류(자료해석 등) 과목뿐 아니라 7급/9급/입법고시 등에서
      // 흔한 과목명도 함께 인식한다. subject 입력란은 자유 텍스트라 못 맞춰도
      // 사용자가 직접 입력하면 되지만, 자동으로 맞으면 그만큼 편해진다.
      const subjectMatch = text.match(
        /(자료해석|언어논리|상황판단|경제학|행정법|행정학|헌법|노동법|국어|영어|한국사|민법|형법|회계학|통계학)/
      );
      const roundMatch = text.match(/([가-힣①-⑮㉮-㉻]{1}\s*책형)/) || text.match(/(책형\s*[가-힣①-⑮㉮-㉻]{1})/);
      let examType = '';
      if (/5급/.test(text)) examType = '5급공채';
      else if (/7급/.test(text)) examType = '7급공채';
      else if (/입법고시/.test(text)) examType = '입법고시';
      else if (/민간경력|민경채/.test(text)) examType = '민경채';
      else if (/9급/.test(text)) examType = '9급공채';
      return {
        year: yearMatch ? yearMatch[1] : '',
        title: titleMatch ? titleMatch[1].trim() : '',
        subject: subjectMatch ? subjectMatch[1] : '',
        round: roundMatch ? roundMatch[1].replace(/\s+/g, '') : '',
        examType,
      };
    }

    // 한 페이지의 머리말 영역(맨 위 headerRatio*1.6)과 꼬리말 영역(맨 아래
    // 같은 비율)의 텍스트를 각각 모아서 반환한다.
    async function scanPage(pageNum) {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale });
      const textContent = await page.getTextContent();
      const bandH = viewport.height * headerRatio * 1.6;
      const items = textContent.items
        .map((it) => {
          const [vx, vy] = viewport.convertToViewportPoint(it.transform[4], it.transform[5]);
          return { str: it.str, x: vx, y: vy };
        })
        .filter((it) => it.str && it.str.trim());
      const headerItems = items.filter((it) => it.y < bandH).sort((a, b) => a.y - b.y || a.x - b.x);
      const footerItems = items.filter((it) => it.y > viewport.height - bandH).sort((a, b) => a.y - b.y || a.x - b.x);
      const toText = (arr) => arr.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
      return { headerText: toText(headerItems), footerText: toText(footerItems) };
    }

    const result = { year: '', title: '', subject: '', round: '', examType: '' };
    let rawText = '';
    const pagesToScan = Math.min(pdf.numPages, 2);
    outer:
    for (let p = 1; p <= pagesToScan; p++) {
      const { headerText, footerText } = await scanPage(p);
      // 머리말을 꼬리말보다 먼저 검사해서, 정보가 둘 다에 있으면 머리말
      // 쪽을 우선한다.
      for (const bandText of [headerText, footerText]) {
        if (!bandText) continue;
        if (!rawText) rawText = bandText;
        const found = extractFrom(bandText);
        for (const key of FIELD_KEYS) {
          if (!result[key] && found[key]) result[key] = found[key];
        }
        if (FIELD_KEYS.every((k) => result[k])) break outer;
      }
    }

    // 머리말/꼬리말에서 못 찾은 필드는 파일명에서 추정한다(예:
    // "221015_국가_7급_2차_경제학-나.pdf" → 연도 2022, 과목 경제학, 
    // 유형 7급공채, 책형 나).
    const fnGuess = guessFromFileName(file.name);
    for (const key of FIELD_KEYS) {
      if (!result[key] && fnGuess[key]) result[key] = fnGuess[key];
    }
    if (!result.title) result.title = rawText.slice(0, 40) || '';

    return { rawText, ...result };
  }

  /**
   * 파일명에서 연도/과목/책형/시험유형을 최대한 추정한다. 머리말·꼬리말
   * 둘 다에서 아무 정보도 못 찾았을 때의 최후 수단.
   * 예: "221015_국가_7급_2차_경제학-나.pdf"
   *     → { year:'2022', subject:'경제학', round:'나', examType:'7급공채' }
   */
  function guessFromFileName(name) {
    const base = (name || '').replace(/\.[a-zA-Z0-9]+$/, '');
    // "20XX" 형태의 4자리 연도가 그대로 있으면 그걸 쓰고, 없으면
    // "221015"(YYMMDD 6자리, 원본 시험지 파일 흔한 명명 관례) 같은 패턴에서
    // 앞 2자리를 20XX로 변환해 추정한다.
    const yearMatch = base.match(/(20\d{2})/) || base.match(/(?:^|[_\-])(\d{2})\d{2}\d{2}(?:[_\-]|$)/);
    let year = '';
    if (yearMatch) year = yearMatch[0].replace(/[^\d]/g, '').length >= 6 ? ('20' + yearMatch[1]) : yearMatch[1];
    const subjectMatch = base.match(
      /(자료해석|언어논리|상황판단|경제학|행정법|행정학|헌법|노동법|국어|영어|한국사|민법|형법|회계학|통계학)/
    );
    // "나책형"(뒤에 책형) 또는 "_나"/"-나"(구분자로 둘러싸인 글자 하나,
    // 파일명 끝에 책형만 달랑 붙는 흔한 관례) 순으로 시도한다.
    const roundMatch = base.match(/([가-힣])\s*책형/) || base.match(/(?:^|[_\-])([가-힣])(?:[_\-]|$)/);
    let examType = '';
    if (/5급/.test(base)) examType = '5급공채';
    else if (/7급/.test(base)) examType = '7급공채';
    else if (/입법고시/.test(base)) examType = '입법고시';
    else if (/민간경력|민경채/.test(base)) examType = '민경채';
    else if (/9급/.test(base)) examType = '9급공채';
    return {
      year,
      subject: subjectMatch ? subjectMatch[1] : '',
      round: roundMatch ? roundMatch[1] : '',
      examType,
    };
  }

  /**
   * 컬럼 영역 [xStart,xEnd) x [yTop,yBottom) 을 훑어서, 각 가로줄(행)에
   * "잉크(흰색이 아닌 픽셀)"가 있는지 여부를 배열로 계산해 반환한다.
   * 텍스트든 그래프든 표든 상관없이 실제로 렌더링된 내용이 있으면 잡아낸다.
   */
  function computeInkRows(ctx, xStart, xEnd, yTop, yBottom) {
    const x0 = Math.max(0, Math.floor(xStart));
    const w = Math.max(1, Math.floor(xEnd) - x0);
    const y0 = Math.max(0, Math.floor(yTop));
    const h = Math.max(1, Math.ceil(yBottom) - y0);

    let data;
    try {
      data = ctx.getImageData(x0, y0, w, h).data;
    } catch (e) {
      // 캔버스 픽셀을 못 읽으면(이론상 발생 안 함) 전부 "잉크 있음"으로 처리해
      // 기존 텍스트 기반 로직처럼 안전하게 동작하도록 한다.
      return { inkRows: new Array(h).fill(true), yOffset: y0 };
    }

    const stepX = Math.max(1, Math.floor(w / 150)); // 행당 대략 150개 샘플
    const inkRows = new Array(h).fill(false);
    for (let row = 0; row < h; row++) {
      const rowOffset = row * w * 4;
      let inkCount = 0;
      for (let col = 0; col < w; col += stepX) {
        const idx = rowOffset + col * 4;
        const lum = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
        if (lum < 250) {
          inkCount++;
          if (inkCount >= 2) break;
        }
      }
      inkRows[row] = inkCount >= 2;
    }
    return { inkRows, yOffset: y0 };
  }

  /**
   * inkProfile에서 [y1, upperBound) 구간을 위→아래로 훑어, gapPx 이상 흰
   * 여백이 이어지는 지점을 찾는다. 단, markerYs(이 구간 안에서 "마지막
   * 선택지" 문자(④ 또는 ⑤, 문서에 따라 다름)가 등장하는 y좌표들)가 주어지면,
   * **그중 하나를 이미 지난 뒤에 나온 여백만** 진짜 끝으로 인정한다 — 아직
   * 마지막 선택지가 나오기 전에 발견된 여백(예: 표와 <보기> 사이의 큰 간격)은
   * 문제 중간의 단순 여백으로 보고 무시하고 계속 스캔한다.
   * @returns {{end:number, hadGap:boolean, sawInk:boolean}} hadGap=false면
   *   그 구간 끝까지 내용이 이어졌다는 뜻(=아직 안 끝났을 수 있음).
   *   sawInk=false면 이 구간에 내용이 전혀 없었다는 뜻(빈 구간).
   */
  function findContentEndPx(inkProfile, y1, upperBound, gapPx, markerYs = []) {
    const { inkRows, yOffset } = inkProfile;
    const startIdx = Math.max(0, Math.floor(y1 - yOffset));
    const endIdx = Math.min(inkRows.length, Math.ceil(upperBound - yOffset));

    let lastInkY = y1;
    let sawInk = false;
    let blankRunStartY = null;
    let markerIdx = 0;
    let seenMarker = false;

    for (let i = startIdx; i < endIdx; i++) {
      const y = i + yOffset;
      while (markerIdx < markerYs.length && markerYs[markerIdx] <= y) {
        seenMarker = true;
        markerIdx++;
      }
      if (inkRows[i]) {
        lastInkY = y;
        sawInk = true;
        blankRunStartY = null;
      } else {
        if (blankRunStartY === null) blankRunStartY = y;
        if (y - blankRunStartY >= gapPx && seenMarker) {
          return { end: sawInk ? lastInkY + 4 : y1, hadGap: true, sawInk };
        }
      }
    }
    return { end: sawInk ? lastInkY + 4 : y1, hadGap: false, sawInk };
  }

  /** 한 컬럼 안의 줄 간격(줄 사이 y 차이) 중앙값을 줄 높이로 추정 */
  function estimateLineHeight(lines, fallback = 16) {
    if (!lines || lines.length < 2) return fallback;
    const gaps = [];
    for (let i = 1; i < lines.length; i++) {
      const g = lines[i].y - lines[i - 1].y;
      if (g > 1 && g < fallback * 4) gaps.push(g);
    }
    if (gaps.length === 0) return fallback;
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)];
  }

  /** 캔버스에서 지정 영역을 잘라 Blob(JPEG)으로 반환 */
  function cropToBlob(pageCanvas, box, quality = 0.85) {
    const c = document.createElement('canvas');
    const w = Math.max(1, Math.round(box.w));
    const h = Math.max(1, Math.round(box.h));
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(
      pageCanvas,
      Math.round(box.x),
      Math.round(box.y),
      w,
      h,
      0,
      0,
      w,
      h
    );
    return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', quality));
  }

  /** 작은 썸네일(dataURL) 생성 */
  function cropToThumbDataURL(pageCanvas, box, maxWidth = 220) {
    const ratio = box.h / box.w;
    const w = Math.min(maxWidth, box.w);
    const h = Math.round(w * ratio);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(pageCanvas, box.x, box.y, box.w, box.h, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.6);
  }

  return { analyze, detectHeader, cropToBlob, cropToThumbDataURL };
})();

window.PDFAnalyze = PDFAnalyze;
