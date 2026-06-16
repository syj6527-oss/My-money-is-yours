// 💰 전리품 (Spoils) — v0.5.0
// 감정(카테고리+물건버리기) → 인수 → 금고 / 알바지옥(기록 분리·후기·별점·채팅핀). chat_metadata 채팅별 격리.

const LOG = '[전리품]';
const KEY = 'spoils';
const COOLDOWN_MS = 30 * 60 * 1000; // 새 일거리 전체 리셋 30분
const logBuf = [];
function dbg(...args) {
    const line = args.map(a => typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch (e) { return String(a); } })()).join(' ');
    logBuf.push(`[${new Date().toLocaleTimeString()}] ${line}`);
    if (logBuf.length > 120) logBuf.shift();
    console.log(LOG, ...args);
}
const CATS = ['현금', '예적금', '주식·투자', '부동산', '차량', '귀중품', '물건', '빚'];
const CAT_ICON = { '현금': '💵', '예적금': '🏦', '주식·투자': '📈', '부동산': '🏠', '차량': '🚗', '귀중품': '💎', '물건': '📦', '빚': '💸' };

// ── 금액 ──
function parseWon(s) {
    if (typeof s === 'number') return Math.round(s);
    s = String(s ?? '').replace(/[, ]/g, '');
    let v = 0, m;
    m = s.match(/([\d.]+)억/); if (m) v += parseFloat(m[1]) * 1e8;
    m = s.match(/([\d.]+)만/); if (m) v += parseFloat(m[1]) * 1e4;
    m = s.match(/([\d.]+)천(?!만)/); if (m) v += parseFloat(m[1]) * 1e3;
    if (!/[억만천]/.test(s)) { const n = s.match(/[\d.]+/); if (n) v += parseFloat(n[0]); }
    return Math.round(v);
}
function fmtWon(v) {
    v = Math.round(v || 0); const sign = v < 0 ? '-' : ''; v = Math.abs(v);
    if (v === 0) return '0원';
    if (v >= 1e8) { const e = v / 1e8; return sign + (e % 1 ? e.toFixed(1) : e) + '억'; }
    if (v >= 1e4) return sign + Math.round(v / 1e4).toLocaleString() + '만원';
    return sign + v.toLocaleString() + '원';
}
function esc(s) { return $('<i>').text(String(s ?? '')).html(); }
function ctx() { return SillyTavern.getContext(); }
function itemVal(it) { return (it.debt ? -1 : 1) * parseWon(it.value); }
function sumCat(items, cat) { return (items || []).filter(it => it.category === cat).reduce((s, it) => s + parseWon(it.value), 0); }
function sumAll(items) { return (items || []).reduce((s, it) => s + itemVal(it), 0); }

// ── 상태 ──
function getState() {
    const md = ctx().chatMetadata; if (!md) return null;
    if (!md[KEY]) md[KEY] = { vault: [], userAssets: [], userData: null, chars: {}, extraNames: [] };
    if (!md[KEY].userAssets) md[KEY].userAssets = [];
    if (!md[KEY].extraNames) md[KEY].extraNames = [];
    return md[KEY];
}
function saveState() {
    const c = ctx();
    try {
        if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
        else if (typeof c.saveMetadata === 'function') c.saveMetadata();
        else if (typeof c.saveChatDebounced === 'function') c.saveChatDebounced();
        else console.warn(LOG, '메타데이터 저장 함수 못 찾음');
    } catch (e) { console.warn(LOG, '저장 실패', e); }
}
function charState(name) {
    const st = getState();
    if (!st.chars[name]) st.chars[name] = { appraised: false, data: null, handedOver: false, balance: 0, alba: null, workLog: [] };
    return st.chars[name];
}
function candidateChars() {
    const c = ctx(); const out = [];
    if (c.groupId) {
        const g = (c.groups || []).find(x => x.id === c.groupId);
        (g?.members || []).forEach(av => { const ch = (c.characters || []).find(x => x.avatar === av); if (ch) out.push(ch); });
    } else if (c.characters && c.characterId != null && c.characters[c.characterId]) out.push(c.characters[c.characterId]);
    return out;
}

// ── 수집 + 감정 ──
function gatherCard(char) { return [char.name ? `이름: ${char.name}` : '', char.description, char.personality, char.scenario].filter(Boolean).join('\n').slice(0, 5000); }
function gatherUserCard() {
    const c = ctx();
    const name = c.name1 || (c.substituteParams ? c.substituteParams('{{user}}') : '') || '유저';
    let persona = '';
    try { persona = c.substituteParams ? c.substituteParams('{{persona}}') : ''; } catch (e) { /* ignore */ }
    if (!persona) persona = c.powerUserSettings?.persona_description || '';
    return { name, card: `이름: ${name}\n${persona}`.trim() };
}
function gatherChat() { try { return (ctx().chat ?? []).slice(-50).map(m => `${m.name}: ${m.mes}`).join('\n').slice(0, 7000); } catch (e) { return ''; } }
async function gatherLore(char) {
    const c = ctx(); const names = new Set();
    try {
        const bound = char?.data?.extensions?.world; if (bound) names.add(bound);
        (c.selected_world_info ?? globalThis.selected_world_info ?? []).forEach(n => names.add(n));
        const cl = c.chatMetadata?.world_info ?? c.chat_metadata?.world_info; if (cl) names.add(cl);
    } catch (e) { console.warn(LOG, '로어북 이름 수집', e); }
    let text = '';
    for (const name of names) {
        try { const d = await c.loadWorldInfo(name); if (d?.entries) text += Object.values(d.entries).map(e => e.content).filter(Boolean).join('\n') + '\n'; }
        catch (e) { console.warn(LOG, 'loadWorldInfo', name, e); }
    }
    return text.slice(0, 6000);
}

function buildPrompt(name, card, chat, lore) {
    return `넌 데드팬 유머 감각을 가진 재산 감정사다. 아래 대상을 읽고, 지금 "인수"하게 될 자산을 감정한다.

[원칙]
- 채팅·로어북·카드에 실제로 등장한 소지품과 재산은 그대로 반영한다.
- 비어있는 부분은 대상의 처지·성격·세계관에 어울리게 그럴듯하게 채워 지어낸다.
- items에는 유저가 손에 쥘 수 있는 "자산"만 넣는다. 빚·부채는 items에 절대 넣지 않는다.
- hidden_debt: 캐릭터의 성격·처지상 빚이나 갚을 게 있을 법하면 채운다. 거창한 빚(도박빚/카드론/사채)뿐 아니라 소소한 것도 좋다 — 친구한테 빌린 3만원, 안 갚은 회식비, 반납 안 한 도서관 책, 빌리고 안 돌려준 우산처럼. 금액이 작거나 물건이어도 OK. 없을 것 같으면 null. 유저에게 보이지 않는 숨은 항목이다.
- 모든 자산은 items에 넣고 category로 분류한다: 현금 / 예적금 / 주식·투자 / 부동산 / 차량 / 귀중품 / 물건.
  현금·통장 잔액·주식도 각 category로. 소소한 소지품·잡동사니는 "물건"으로.
- 부유하면 값나가는 것을, "찐거지"라면 "물건" category에 거의 무가치한 잡동사니(0원)를 진지한 척 기재한다.
- 자산 수준과 무관하게, "물건" category에는 거의 쓰레기에 가까운 잡템을 1~3개 반드시 섞는다.
  (예: 한 짝뿐인 양말, 말라붙은 볼펜, 영수증 뭉치, 다 쓴 기프티콘, 바닥에 굴러다니던 동전, 유통기한 지난 사탕)
  부자 주머니에도 잡동사니는 있다. 0원이나 푼돈으로 진지하게 적는다.
- 각 category 안에서도 구체적이고 서로 다른 품목으로 채운다. 뻔한 일반명사 나열이나 같은 브랜드·품목 반복은 피한다.
  (부동산=구체 매물·지역, 주식·투자=종목/코인명, 차량=구체 모델, 예적금=상품명·통화)
  귀중품은 폭넓게 — 시계·보석·반지·미술품·골동품·악기·명품가방·한정판 수집품·금괴·고급 와인·만년필 등 매번 다른 종류로. 같은 명품 시계만 반복하지 말 것.
- 금액(value/worth)은 숫자+통화 위주로. 비꼬는 부연은 note에, 금액 옆 괄호는 한두 단어로 짧게.
- note는 짧고 건조하게. persona는 성격+말투 한 줄 요약, 역시 건조하게.
- tier는 자산 등급을 위트있는 짧은 라벨로 자유롭게 짓는다 (거지 / 생계형 인간 / 평범한 시민 / 부자 / 상속세의 화신 등, 캐릭터 맞춤).
- verdict는 자산 구성을 꿰뚫는 감정사의 독설 한 줄. 위트있되 인신공격 직전에서 멈춘다.
  (예: "돈은 많지만 내일 아침 커피 살 현금은 없음", "자산보다 자신감이 더 많은 사람", "세무서가 좋아할 구성")
- reaction은 유저가 이 인물의 재산을 전부 가져갈 때 인물이 보일 반응을, 그 인물의 말투 그대로 한두 마디 + 상황에 맞는 이모지 1개.
  처지에 맞게: 빈털터리는 절망·매달림("자기야… 나 어떻게 살아 😭"), 부자는 코웃음·무관심, 자존심 강하면 허세 등. 감정적이든 시니컬하든 캐릭터답게.
- 전체 톤은 그 인물이 실제로 말하듯 자연스럽고 캐주얼하게(딱딱한 보고서체 금지). 말끝은 그 인물이 평소 채팅에서 쓰는 입말체로(긴 문어체·번역투 어미 대신 평소 말투). note·verdict·reaction엔 채팅에 나온 실제 사건·관계·디테일·말버릇을 끌어와 구체적이고 예상 밖이게. 인물(과 유저)의 성격·관계가 자산 구성과 반응에 드러나게. 뻔하지 않게, 웃기게.
- ★ 가장 중요: verdict·reaction·persona는 아래 [말투 예시]에 드러난 이 인물 고유의 어휘·어미·말버릇·리듬·성격을 그대로 살린다. 일반적인 말투가 아니라 '${name}' 본인의 목소리여야 한다. 1인칭 대사(reaction)는 특히 평소 채팅 말투 그대로.
- 세계관에 맞는 통화·단위. 대상/채팅과 같은 언어로. 불명확하면 한국어.

[출력] 아래 JSON 객체 하나만. 코드펜스·설명 없이.
{
  "tier": "자산 등급 (위트있는 짧은 라벨)",
  "income": { "monthly": "월수입", "source": "수입원" },
  "items": [ { "category": "현금|예적금|주식·투자|부동산|차량|귀중품|물건", "icon": "이모지", "name": "품목", "value": "가치", "note": "건조한 한 줄" } ],
  "worth": "추정 총액",
  "verdict": "감정사의 독설 한 줄",
  "persona": "성격 + 말투 한 줄 데드팬",
  "reaction": "전 재산을 빼앗길 때 이 인물이 내뱉는 한두 마디 (인물 말투 + 이모지 1개)",
  "hidden_debt": null 또는 { "icon": "💸", "name": "빚 이름", "value": "금액", "note": "건조한 한 줄" }
}

[대상: ${name}]
=== 카드 ===
${card || '(없음)'}
=== 로어북 ===
${lore || '(없음)'}
=== ${name}의 말투 예시 (이 어조를 살릴 것) ===
${recentLinesOf(name, 10) || '(없음)'}
=== 최근 대화 ===
${chat || '(없음)'}`;
}
function parseResult(raw) {
    let s = String(raw ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a !== -1 && b > a) s = s.slice(a, b + 1);
    return JSON.parse(s);
}
function profileId() { const c = ctx(); return c.extensionSettings?.spoils?.profileId || c.extensionSettings?.connectionManager?.selectedProfile; }
async function llmJSON(prompt, tokens) {
    const c = ctx(), pid = profileId();
    if (!pid) { toastr.warning('설정창(Extensions → 💰 전리품)에서 연결 프로필을 골라줘'); return null; }
    const resp = await c.ConnectionManagerRequestService.sendRequest(pid, prompt, tokens || 4096);
    const raw = (typeof resp === 'string') ? resp : (resp?.content ?? '');
    dbg('응답:', String(raw).slice(0, 600));
    return parseResult(raw);
}
async function runAppraisal(name, card, lore) {
    if (!profileId()) { toastr.warning('설정창(Extensions → 💰 전리품)에서 연결 프로필을 골라줘'); return null; }
    dbg('감정 시작:', name);
    toastr.info(`${name} 감정 중…`, '💰 전리품', { timeOut: 0, tag: 'spoils' });
    try { const d = await llmJSON(buildPrompt(name, card, gatherChat(), lore), 4096); toastr.clear(); return d; }
    catch (e) {
        toastr.clear(); dbg('감정 실패:', e?.message || String(e));
        const msg = String(e?.message || e);
        if (/empty|candidate|safety|block/i.test(msg)) toastr.error('모델이 빈 응답을 반환했어. 연결 프로필 안전설정을 끄거나 토큰을 늘려봐.', '', { timeOut: 8000 });
        else toastr.error('감정 실패. 콘솔/로그 확인.');
        return null;
    }
}
async function appraiseChar(char) { return runAppraisal(char.name, gatherCard(char), await gatherLore(char)); }
async function appraiseUser() { const u = gatherUserCard(); return runAppraisal(u.name, u.card, ''); }
async function appraiseByName(name) {
    const base = ui.chars[0];
    const card = base ? gatherCard(base) : '';
    const lore = base ? await gatherLore(base) : '';
    return runAppraisal(name, card, lore);
}
function normItems(d) { return (d.items || []).filter(it => it.category !== '빚').map(it => ({ category: CATS.includes(it.category) ? it.category : '물건', icon: it.icon, name: it.name, value: it.value, note: it.note })); }

// ── 알바지옥 ──
const JOB_POOL = [
    { ic: '🏪', n: '편의점 야간', pay: 3, note: '폐기 삼각김밥 덤' },
    { ic: '🛠️', n: '일용직 현장', pay: 13, note: '양말에 모래 몇 줌 묻어옴' },
    { ic: '📖', n: '주말 과외', pay: 5, note: '학부모 카톡 시달림' },
    { ic: '🚚', n: '택배 상하차', pay: 11, note: '허리에서 소리 남' },
    { ic: '🐕', n: '강아지 산책 대행', pay: 2, note: '리드줄에 손 쓸림' },
    { ic: '☕', n: '카페 마감조', pay: 4, note: '우유 거품 자국 안 지워짐' },
    { ic: '📦', n: '새벽 물류 분류', pay: 6, note: '졸음과의 사투' },
    { ic: '🎮', n: 'PC방 카운터', pay: 4, note: '온몸에 라면 냄새 배임' },
    { ic: '🩸', n: '헌혈 (기념품)', pay: 0, note: '초코파이 2개 + 음료수' },
    { ic: '🗑️', n: '폐지 수거', pay: 1, note: '리어카는 무료 대여' },
    { ic: '📄', n: '전단지 배포', pay: 2, note: '절반은 어딘가에 버려짐' },
    { ic: '🥟', n: '마트 시식 코너', pay: 4, note: '퇴근 후에도 만두 냄새' },
    { ic: '🍿', n: '영화관 청소', pay: 3, note: '팝콘은 좌석 틈마다 있다' },
    { ic: '🚗', n: '주차 대행', pay: 5, note: '남의 외제차 긁을 뻔' },
    { ic: '🚙', n: '대리운전', pay: 7, note: '취객의 인생사 청취 포함' },
    { ic: '🧳', n: '단기 이삿짐', pay: 9, note: '냉장고는 혼자 못 든다' },
    { ic: '🎀', n: '행사 도우미', pay: 5, note: '하루 종일 같은 멘트 반복' },
    { ic: '🧦', n: '빨래방 관리', pay: 3, note: '남의 양말 분실 책임' },
    { ic: '📋', n: '길거리 설문조사', pay: 3, note: '문전박대 30회 기본' },
    { ic: '🐻', n: '인형탈 알바', pay: 6, note: '탈 안에서 땀 한 바가지' },
    { ic: '🥬', n: '김장철 배추 절이기', pay: 5, note: '손이 소금에 절여짐' },
    { ic: '🏷️', n: '벼룩시장 좌판', pay: 2, note: '안 팔리는 게 디폴트' },
    { ic: '🖱️', n: '데이터 라벨링', pay: 4, note: '고양이인지 개인지 1만 장' },
    { ic: '🧍', n: '줄서기 대행', pay: 3, note: '남 대신 4시간 서 있기' },
    { ic: '👏', n: '방청객 알바', pay: 3, note: '박수 부대, 웃음 강제' },
    { ic: '🎁', n: '결혼식 하객 알바', pay: 5, note: '신부 측 사촌 역할' },
    { ic: '🧻', n: '도배 보조', pay: 8, note: '풀 냄새 + 종일 천장 보기' },
    { ic: '🍞', n: '붕어빵 노점 보조', pay: 3, note: '팥소에 손등 데임' },
    { ic: '🍜', n: '컵라면 공장 라인', pay: 6, note: '스프 냄새 영구 각인' },
    { ic: '🕯️', n: '장례식장 도우미', pay: 7, note: '분위기 파악이 8할' },
    { ic: '🛗', n: '쿠팡 새벽배송', pay: 9, note: '엘베 없는 빌라 5층' },
    { ic: '🍎', n: '과수원 농활', pay: 6, note: '사과 1톤, 멀쩡한 허리 0개' },
    { ic: '🛵', n: '배달 라이더', pay: 8, note: '비 오면 수입 2배, 위험 5배' },
    { ic: '🐟', n: '수산시장 손질', pay: 7, note: '비린내는 영혼까지 스밈' },
    { ic: '🧹', n: '모텔 객실 청소', pay: 5, note: '본 것은 잊기로 함' },
    { ic: '📞', n: '콜센터 단기', pay: 5, note: '욕은 기본 옵션' },
    { ic: '🧁', n: '베이커리 새벽', pay: 6, note: '밀가루 인간이 됨' },
    { ic: '🪧', n: '1인 시위 대행', pay: 4, note: '내 신념은 아니지만' },
    { ic: '🧊', n: '횟집 얼음 나르기', pay: 5, note: '손 감각과 잠시 작별' },
    { ic: '🎅', n: '시즌 한정 산타', pay: 6, note: '무릎에 애들 12명' },
    { ic: '🛒', n: '마트 카트 정리', pay: 3, note: '주차장이 곧 헬스장' },
    { ic: '🎤', n: '행사 MC 보조', pay: 5, note: '대본에 없는 애드립 강요' },
];
const SNARK = ['일이 그렇게 안 급한가 봐?', '골라잡을 처지는 아닐 텐데.', '오늘 치 일감은 동났어. 내일 다시 오든가.'];
const INCIDENTS = [
    '술 취한 손님과 철학 토론 발생',
    '사장이 자긴 좋은 사람이라고 세 번 강조함',
    '옆 알바생이 갑자기 인생 상담을 시작함',
    '최저시급이 맞는지 끝까지 의심됨',
    '퇴근 직전 추가 업무가 투척됨',
    '사장 아들이 와서 훈수를 둠',
    '손님이 반말로 컴플레인 후 어색하게 사과함',
    '화장실 청소가 슬며시 업무에 포함됨',
    '4대보험 얘기를 꺼내자 분위기 싸해짐',
    'CCTV가 유난히 많았음',
    '쉬는 시간은 전설 속 이야기였음',
    '손님이 번호를 물어봄 (정중히 거절)',
    '"오늘만 좀 일찍" 이 세 번째였음',
    '경력에 한 줄도 못 쓸 일이었음',
    '"이거 원래 네 일 아니야?"를 들음',
    '단골이 인생 조언을 시전함',
    '월급날이 슬그머니 미뤄짐',
    '유니폼이 한 사이즈 작았음',
    '"열정페이" 라는 단어가 등장함',
    '사장 반려견이 더 상전이었음',
    '휴게실 의자가 단 한 개였음',
    '진상 손님 응대 후 스스로에게 박수침',
    '사장이 알바보다 자주 사라짐',
    '퇴근 도장 찍는 법을 끝내 못 배움',
];
function pickIncident() { return Math.random() < 0.5 ? INCIDENTS[Math.floor(Math.random() * INCIDENTS.length)] : null; }
function rollPage() { return [...JOB_POOL].sort(() => Math.random() - 0.5).slice(0, 3 + Math.floor(Math.random() * 3)); }
function ensureAlba(cs) {
    if (!cs.alba || (cs.alba.resetAt && Date.now() >= cs.alba.resetAt))
        cs.alba = { budget: 3 + Math.floor(Math.random() * 3), rolls: 0, jobs: rollPage(), resetAt: null };
    return cs.alba;
}
let logSeq = 0;
function newWorkId() { return 'w' + Date.now().toString(36) + '-' + (logSeq++).toString(36); }
function migrateLog(cs) { (cs.workLog || []).forEach(r => { if (!r.id) r.id = newWorkId(); }); }
function recentLinesOf(name, n) {
    try { return (ctx().chat || []).filter(m => !m.is_user && m.name === name).slice(-n).map(m => `- ${String(m.mes).replace(/\s+/g, ' ').slice(0, 120)}`).join('\n'); }
    catch (e) { return ''; }
}
async function genReview(cs, entry) {
    const char = ui.chars.find(x => x.name === ui.sel);
    const persona = cs.data?.persona || '';
    const card = char ? gatherCard(char) : '';
    const voice = recentLinesOf(ui.sel, 10);
    const prompt = `'${ui.sel}'가 방금 '${entry.n}' 알바(${entry.pay > 0 ? entry.pay + '만원' : '무급'}, 특이사항: ${entry.note}${entry.incident ? ', ' + entry.incident : ''})를 마쳤다. RP 장면처럼 자연스럽게 출력한다.
- before: 이 알바를 '시작하기 전' ${ui.sel}이 속으로 내뱉은 한 줄 평. 그 알바를 만만하게 보거나/꺼리거나/얕본 선입견 위주로, 이 캐릭터 말투로. (예: 대리운전 → "운전 정도야 껌이지", 상하차 → "막노동은 좀…")
- scene: 알바 중이거나 막 끝낸 ${ui.sel}을 그린 2~4문장의 자연스러운 묘사. 소설 한 단락처럼 보여주기(show)와 데드팬으로. ★before의 선입견과 실제가 어긋나는 '괴리감'을 은근히 드러내면 좋다(만만히 봤는데 빡셌다 / 꺼렸는데 의외로 맞더라 등). 채팅 속 말투·성격 반영, 설명조·문어체 금지.
- rn: 알바를 끝낸 지금 ${ui.sel}이 속으로 굴리는 생각 한 줄(before와 대비되는 깨달음/투덜거림이면 더 좋다). 담백하게.
- mood: 이모지 1개 + 짧은 분위기 한 마디 (예: "🥱 영혼 가출 직전").
- stars: 이 캐릭터 기준 별점 1~5 정수.
★ before·rn·scene 모두 [말투 예시]에 드러난 ${ui.sel} 고유의 어휘·어미·말버릇 그대로. 일반적 말투 말고 이 인물 본인의 목소리로.
[성격] ${persona || '(없음)'}
[설정] ${card.slice(0, 1500) || '(없음)'}
[말투 예시 — 이 캐릭터의 최근 대사]
${voice || '(없음)'}
[출력] JSON 하나만, 코드펜스 없이:
{ "before": "알바 전 한 줄 평", "scene": "2~4문장 장면 묘사", "mood": "이모지 + 분위기 한 마디", "rn": "끝낸 뒤 속마음 한 줄", "stars": 정수 }`;
    try { return await llmJSON(prompt, 4096); }
    catch (e) { dbg('후기 생성 실패:', e?.message || String(e)); toastr.error('후기 생성 실패. 로그 확인.'); return null; }
}
async function genDayReport(name, log) {
    const char = ui.chars.find(x => x.name === name);
    const persona = charState(name).data?.persona || '';
    const voice = recentLinesOf(name, 10);
    const jobs = (log || []).slice().reverse().map(r => `- ${r.n} (${r.pay > 0 ? r.pay + '만원' : '무급'})${r.note ? ' / ' + r.note : ''}${r.incident ? ' / ' + r.incident : ''}`).join('\n');
    const prompt = `'${name}'의 오늘 알바 기록이다. 이걸로 '${name}의 하루'를 일지(log)처럼 만든다.
[오늘 한 일]
${jobs || '(없음)'}

출력:
- timeline: 각 일을 그럴듯한 하루 순서로 배치. 각 항목 { "time": "HH:MM", "job": "알바 이름", "pay": "+N만원 또는 무급", "entry": "그 알바에서 무슨 일이 있었는지 2~3문장의 자연스러운 장면 묘사 (show-don't-tell, 데드팬, 채팅 속 말투·성격·관계 반영)" }. 새벽~밤 사이 시간으로 흩뿌린다.
- diary: 하루를 돌아보는 일기체 2~4문장. ${name}의 말투로 자연스럽고 데드팬하게.
- resolve: 내일(혹은 앞으로)에 대한 다짐 한 줄. ${name}답게 (비장하든 시큰둥하든 캐릭터대로).
- ★ entry·diary·resolve 모두 [말투 예시]에 드러난 ${name} 고유의 어휘·어미·말버릇·성격을 그대로 살린다. 일반적 서술 말고 이 인물의 목소리·시선으로.
[성격] ${persona || '(없음)'}
[말투 예시 — 최근 대사]
${voice || '(없음)'}
[출력] JSON 하나만, 코드펜스 없이: { "timeline": [...], "diary": "...", "resolve": "..." }`;
    try { return await llmJSON(prompt, 4096); }
    catch (e) { dbg('하루 보고서 실패:', e?.message || String(e)); toastr.error('하루 보고서 실패. 로그 확인.'); return null; }
}
async function genSpending(name) {
    const base = ui.chars.find(x => x.name === name);
    const persona = charState(name).data?.persona || '';
    const card = base ? gatherCard(base).slice(0, 1200) : '';
    const voice = recentLinesOf(name, 10);
    const prompt = `캐릭터 "${name}"가 오늘 산 것 3~7개를 적는다.
다양하게 섞는다: 생필품(휴지·두유)부터 사치품, 주식·코인·부동산 같은 큰 지출, 즉흥 감정소비, 계획적인 것까지. 가끔 엉뚱하거나 감정적인 것도(예: "비 맞는 노인에게 우산").
각 "reason"은 이 캐릭터의 말투 그대로 자연스럽고 캐주얼하게(보고서체·문어체 어미 대신 평소 입말). 채팅 맥락·관계·성격을 반영. 짧고 툭 던지는 것 / 감정적인 것 / 어이없는 것을 섞어 웃기게.
★ [말투 예시]에 드러난 이 인물 고유의 어휘·어미·말버릇을 그대로 살려라. 일반적인 말투가 아니라 '${name}' 본인의 목소리로.
[성격] ${persona || '(없음)'}
[설정] ${card || '(없음)'}
[말투 예시 — 최근 대사]
${voice || '(없음)'}
[출력] JSON 하나만, 코드펜스 없이: { "items": [ { "name": "오늘 산 것", "reason": "이 캐릭터 말투의 한 줄 이유" } ] }`;
    try { return await llmJSON(prompt, 4096); }
    catch (e) { dbg('소비 생성 실패:', e?.message || String(e)); toastr.error('소비 생성 실패. 로그 확인.'); return null; }
}

// ── 렌더 ──
const ui = { tab: 'appraise', sel: null, $box: null, chars: [], popup: null, openLog: null, spendBusy: null, compareBusy: false, dayBusy: false, dayOpen: true };

function assetLine(it, opts = {}) {
    const btn = opts.trash ? `<button class="sp-mini trash" data-act="trash" data-idx="${it._i}">🗑️ 버리기</button>`
        : opts.ret ? `<button class="sp-mini" data-act="return" data-idx="${it._i}">되돌려주기</button>` : '';
    return `<div class="sp-line ${parseWon(it.value) === 0 ? 'zero' : ''}">
      <span class="ic">${esc(it.icon || CAT_ICON[it.category] || '📦')}</span>
      <span class="nm">${esc(it.name)}</span>
      ${opts.from ? `<span class="sp-from">${esc(opts.from)}</span>` : ''}
      <span class="vl ${it.debt ? 'debt' : ''}">${it.debt ? '-' : ''}${esc(it.value)}</span>
      ${it.note ? `<span class="nt">${esc(it.note)}</span>` : ''}${btn}</div>`;
}
function renderSections(items, mode) {
    const g = {};
    (items || []).forEach((it, i) => { const c = CATS.includes(it.category) ? it.category : '물건'; (g[c] = g[c] || []).push({ ...it, _i: i }); });
    let html = '';
    CATS.forEach(cat => {
        const arr = g[cat]; if (!arr || !arr.length) return;
        const rows = arr.map(it => assetLine(it, { trash: mode === 'appraise' && cat === '물건', ret: mode === 'vault', from: mode === 'vault' ? it.from : null })).join('');
        html += `<div class="sp-cat"><div class="sp-cat-hd"><span>${CAT_ICON[cat]} ${cat}</span><span class="sp-cat-sum">${fmtWon(arr.reduce((s, it) => s + itemVal(it), 0))}</span></div>${rows}</div>`;
    });
    return html || '<div class="sp-empty">항목이 없습니다.</div>';
}

function render() {
    const st = getState(); if (!st || !ui.$box) return;
    const cs = charState(ui.sel);
    const top = `<div class="sp-top">
      <div class="sp-hd"><button class="sp-reset-hd" data-act="resetall" title="전체 리셋">⟳</button><span class="sp-logo">💰 전리품</span><button class="sp-close" data-act="close" title="닫기">✕</button></div>
      <div class="sp-tabs">
        <div class="sp-tab ${ui.tab === 'appraise' ? 'on' : ''}" data-tab="appraise">감정</div>
        <div class="sp-tab ${ui.tab === 'vault' ? 'on' : ''}" data-tab="vault">금고</div>
        <div class="sp-tab ${ui.tab === 'work' ? 'on' : ''}" data-tab="work">알바지옥</div>
      </div></div>`;
    const body = ui.tab === 'appraise' ? renderAppraise(cs) : ui.tab === 'vault' ? renderVault(st) : renderWork(cs);
    ui.$box.html(`${top}<div class="sp-body">${body}</div>`);
}
function selectableNames() {
    const base = ui.chars.map(c => c.name);
    const ex = (getState()?.extraNames) || [];
    return [...new Set([...base, ...ex])];
}
function charPicker() { return `<select class="sp-select" data-act="pickchar">${selectableNames().map(n => `<option value="${esc(n)}" ${n === ui.sel ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`; }
function charLabel() { return selectableNames().length > 1 ? charPicker() : `<span class="sp-charname">${esc(ui.sel)}</span>`; }

function appraisedList() {
    const st = getState(); if (!st) return [];
    return selectableNames().map(n => {
        const c = st.chars?.[n];
        if (!c?.appraised || !c.data) return null;
        const v = parseWon(c.data.worth) || sumAll(c.data.items);
        return { name: n, worth: c.data.worth || fmtWon(sumAll(c.data.items)), v };
    }).filter(Boolean).sort((a, b) => b.v - a.v);
}
function renderCompare() {
    const st = getState(); if (!st) return '';
    const list = appraisedList();
    if (list.length < 2) return '';
    const medals = ['🥇', '🥈', '🥉'];
    const rows = list.map((e, i) => `<div class="sp-rankrow"><span class="rk">${medals[i] || (i + 1) + '위'}</span><span class="rn">${esc(e.name)}</span><span class="rv">${esc(e.worth)}</span></div>`).join('');
    const body = ui.compareBusy
        ? '<div class="sp-loading"><span class="sp-spin"></span> 둘을 저울질하는 중…</div>'
        : (st.compareQuip ? `<div class="sp-quip">“${esc(st.compareQuip)}”</div>` : '');
    return `<div class="sp-card">
      <div class="sp-cardhead"><span class="sp-ttl">📊 재산 비교</span><button class="sp-btn ghost sm" data-act="comparequip">${st.compareQuip ? '다시 비교평' : '비교평'}</button></div>
      <div class="sp-rank">${rows}</div>
      ${body}
    </div>`;
}

function renderAppraise(cs) {
    const multi = selectableNames().length > 1;
    const isExtra = !ui.chars.find(x => x.name === ui.sel);
    const top = `<div class="sp-charbar">${charLabel()}<span class="sp-bar-btns">${multi ? '<button class="sp-btn ghost sm" data-act="appraiseall">전체 감정</button>' : ''}<button class="sp-btn sm" data-act="appraise">${cs.appraised ? '다시 감정' : '감정하기'}</button></span></div>
      <div class="sp-addchar"><input class="sp-in" data-act="newchar" placeholder="이 시트 속 다른 인물 이름 추가"><button class="sp-mini" data-act="addchar">+ 추가</button>${isExtra ? '<button class="sp-mini trash" data-act="rmchar">제거</button>' : ''}</div>`;
    let assets;
    if (cs.appraised && cs.data) {
        const d = cs.data;
        assets = `<div class="sp-card">
          <div class="sp-ttl">${esc(ui.sel)} 재산${d.tier ? `<span class="sp-tier">${esc(d.tier)}</span>` : ''}</div>
          <div class="sp-income"><span class="lbl">월수입</span><span class="r"><span class="amt">${esc(d.income?.monthly || '?')}</span><span class="src">${esc(d.income?.source || '')}</span></span></div>
          ${renderSections(d.items, 'appraise')}
          <div class="sp-total"><span class="lbl">추정 총액</span><span class="amt">${esc(d.worth || '?')}</span></div>
          ${d.verdict ? `<div class="sp-judge"><span class="jl">감정사 평가</span>“${esc(d.verdict)}”</div>` : ''}
          ${cs.handedOver ? '<div class="sp-done">이미 인수 완료</div>' : '<div class="sp-handover"><button class="sp-btn" data-act="handover">재산 넘기기 ▾</button></div>'}
        </div>`;
    } else assets = `<div class="sp-empty">감정하기를 눌러 ${esc(ui.sel)}의 재산을 감정합니다.</div>`;

    const sp = cs.todaySpend;
    const spendBody = ui.spendBusy === ui.sel
        ? '<div class="sp-loading"><span class="sp-spin"></span> 오늘 뭐 샀나 뒤지는 중…</div>'
        : (sp && sp.length ? sp.map(s => `<div class="sp-spend"><div class="ss-n">${esc(s.name)}</div><div class="ss-r">${esc(s.reason)}</div></div>`).join('') : '<div class="sp-empty">버튼을 누르면 오늘 뭘 샀는지 나옵니다.</div>');
    const spendCard = `<div class="sp-card">
      <div class="sp-cardhead"><span class="sp-ttl">🛒 오늘의 소비</span><button class="sp-btn ghost sm" data-act="spend">${sp && sp.length ? '다시 뽑기' : '뽑기'}</button></div>
      ${spendBody}
    </div>`;

    let slip = '<div class="sp-card"><div class="sp-ttl">인수증</div><div class="sp-slip empty">아직 인수한 게 없습니다.</div></div>';
    if (cs.handedOver && cs.data) {
        const d = cs.data;
        const lines = (d.items || []).map(it => `<div class="sp-line"><span class="ic">${esc(it.icon || CAT_ICON[it.category] || '•')}</span><span class="nm">${esc(it.name)}</span><span class="vl">${esc(it.value)}</span></div>`).join('');
        const debtLine = cs.handedDebt ? `<div class="sp-line debtline"><span class="ic">${esc(cs.handedDebt.icon || '💸')}</span><span class="nm">⚠ ${esc(cs.handedDebt.name)} <span class="sp-tag from">딸려옴</span></span><span class="vl debt">-${esc(cs.handedDebt.value)}</span></div>` : '';
        slip = `<div class="sp-card"><div class="sp-ttl">인수증</div>
          <div class="sp-slip"><div class="sp-stamp">인 수 완 료</div>
            <div class="sp-sh"><div class="t">인수 명세서</div><div class="s">${esc(ui.sel)} → 귀하</div></div>
            ${lines}${debtLine}
            <div class="sp-total"><span class="lbl">인수 총액</span><span class="amt">${esc(d.worth || '?')}</span></div>
            ${d.reaction ? `<div class="sp-reaction">“${esc(d.reaction)}”</div>` : ''}
          </div></div>`;
    }
    return top + assets + spendCard + renderCompare() + slip;
}

function renderVault(st) {
    const mine = st.userAssets || [], trans = st.vault || [];
    return `
      <div class="sp-balance"><div class="lbl">내 총자산</div><div class="amt">${fmtWon(sumAll(mine) + sumAll(trans))}</div></div>
      <div class="sp-card">
        <div class="sp-cardhead"><span class="sp-ttl">내 순수 재산 <span class="sp-sub">${fmtWon(sumAll(mine))}</span></span>
          <button class="sp-btn ghost sm" data-act="appraiseuser">${mine.length ? '다시 감정' : '내 재산 감정'}</button></div>
        ${mine.length ? renderSections(mine, 'display') : '<div class="sp-empty">아직 내 재산을 감정하지 않았습니다.</div>'}
      </div>
      <div class="sp-card">
        <div class="sp-cardhead"><span class="sp-ttl">인수한 재산 <span class="sp-sub">${fmtWon(sumAll(trans))}</span></span>${trans.length ? '<button class="sp-btn ghost sm" data-act="returnall">전체 되돌려주기</button>' : ''}</div>
        ${trans.length ? renderSections(trans, 'vault') : '<div class="sp-empty">인수한 재산이 없습니다.</div>'}
      </div>`;
}

function renderLogRow(r) {
    const open = ui.openLog != null && ui.openLog === r.id;
    let detail = '';
    if (open) {
        if (r.review) {
            const rv = r.review;
            const stn = Math.max(0, Math.min(5, rv.stars | 0));
            const stars = '★'.repeat(stn) + '☆'.repeat(5 - stn);
            if (rv.scene || rv.mood || rv.rn) {
                const block = [
                    `근무      ${esc(r.n)}`,
                    `수입      ${r.pay > 0 ? '+' + r.pay + '만원' : '±0'}`,
                    `특이사항    ${esc(r.note || '')}${r.incident ? ' · ' + esc(r.incident) : ''}`,
                    `Mood     ${esc(rv.mood || '')}`,
                    `📋 ${esc(ui.sel)} rn: ${esc(rv.rn || '')}`
                ].join('\n');
                detail = `<div class="sp-review">
                  ${rv.scene ? `<div class="sp-rep-scene">${esc(rv.scene)}</div>` : ''}
                  <pre class="sp-rep-block">${block}</pre>
                  <div class="sp-rep-foot"><span class="sp-stars">${stars}</span></div>
                </div>`;
            } else {
                detail = `<div class="sp-review"><div class="sp-rep-foot"><span class="sp-stars">${stars}</span></div><div class="sp-rep-say">“${esc(rv.review || rv.log || '')}”</div></div>`;
            }
        } else detail = '<div class="sp-review"><div class="sp-loading"><span class="sp-spin"></span> 장면 뽑는 중…</div></div>';
    }
    return `<div class="sp-logrow ${open ? 'open' : ''}" data-act="logopen" data-id="${r.id}">
      <span class="li-ic">${esc(r.ic || '•')}</span>
      <div class="li-body"><div class="li-n">${esc(r.n)}</div>${r.incident ? `<div class="li-inc">특이사항 · ${esc(r.incident)}</div>` : ''}${r.review?.before ? `<div class="li-before">“${esc(r.review.before)}”</div>` : ''}</div>
      <span class="li-p ${r.pay > 0 ? '' : 'zero'}">${esc(r.sign)}</span>
      <span class="li-arrow">${open ? '▴' : '▾'}</span></div>${detail}`;
}
function renderWork(cs) {
    migrateLog(cs);
    const a = ensureAlba(cs);
    const waiting = a.resetAt && Date.now() < a.resetAt;
    const left = a.budget - a.rolls;
    let jobs;
    if (waiting) jobs = `<div class="sp-wait">전체 페이지 대기 중 — <span class="sp-cdt" data-reset="${a.resetAt}"></span> 후 리셋</div>`;
    else if (!a.jobs.length) jobs = `<div class="sp-empty">남은 일거리가 없습니다. 새 일거리를 굴려보세요.</div>`;
    else jobs = a.jobs.map((j, i) => `<div class="sp-job"><span class="ji">${esc(j.ic)}</span>
        <div class="jbody"><div class="jn">${esc(j.n)}</div><div class="jp">${j.pay > 0 ? '일당 ' + j.pay + '만원' : '무급'} · ${esc(j.note)}</div></div>
        <button class="sp-btn ghost sm" data-act="work" data-idx="${i}">일하기</button></div>`).join('');
    const log = cs.workLog || [];
    return `<div class="sp-charbar">${charLabel()}</div>
      <div class="sp-balance"><div class="lbl">${esc(ui.sel)} 잔액</div><div class="amt">${fmtWon(cs.balance)}</div></div>
      <div class="sp-card">
        <div class="sp-cardhead"><span class="sp-ttl">일거리 <span class="sp-budget">${waiting ? '소진' : '굴리기 ' + left + '회 남음'}</span></span>
          <button class="sp-btn ghost sm" data-act="reroll">🎲 새 일거리</button></div>
        <div class="sp-jobs">${jobs}</div></div>
      <div class="sp-card">
        <div class="sp-cardhead"><span class="sp-ttl">알바 기록</span>${log.length ? '<button class="sp-btn ghost sm" data-act="clearlog">🏠 퇴근</button>' : ''}</div>
        ${log.length ? log.map(renderLogRow).join('') : '<div class="empty-hint">아직 한 일이 없습니다. 항목을 누르면 후기가 떠요.</div>'}
      </div>
      ${log.length ? renderDayCard(cs) : ''}`;
}
function renderDayCard(cs) {
    const d = cs.dayReport;
    const open = ui.dayOpen !== false;
    const head = `<div class="sp-cardhead daytoggle" data-act="daytoggle"><span class="sp-ttl">📅 ${esc(ui.sel)}의 하루 <span class="sp-acc">${open ? '▴' : '▾'}</span></span><button class="sp-btn ghost sm" data-act="dayreport">${ui.dayBusy ? '정리 중…' : (d ? '다시 정리' : '하루 정리')}</button></div>`;
    if (!open) return `<div class="sp-card">${head}</div>`;
    let body;
    if (ui.dayBusy) body = '<div class="sp-loading"><span class="sp-spin"></span> 하루를 되짚는 중…</div>';
    else if (!d) body = '<div class="sp-empty">버튼을 누르면 오늘 한 알바로 하루를 정리해줍니다.</div>';
    else {
        const tl = (d.timeline || []).map(t => `<div class="sp-day-entry">
            <div class="sp-day-hd"><span class="dh-t">${esc(t.time || '')}</span><span class="dh-j">${esc(t.job || '')}</span>${t.pay ? `<span class="dh-p">${esc(t.pay)}</span>` : ''}</div>
            ${(t.entry || t.beat) ? `<div class="sp-day-body">${esc(t.entry || t.beat)}</div>` : ''}
          </div>`).join('');
        const diary = d.diary || d.review || '';
        body = `<div class="sp-days">${tl}</div>
          ${diary ? `<div class="sp-diary-box"><div class="sp-diary-lbl">📖 오늘 일기</div><div class="sp-diary-txt">${esc(diary)}</div>${d.resolve ? `<div class="sp-resolve">“${esc(d.resolve)}”</div>` : ''}</div>` : ''}`;
    }
    return `<div class="sp-card">${head}${body}</div>`;
}

// ── 액션 ──
async function onAction(e) {
    const el = e.target.closest('[data-act]');
    if (!el) { const tab = e.target.closest('.sp-tab'); if (tab) { ui.tab = tab.dataset.tab; render(); } return; }
    const act = el.dataset.act, st = getState(), cs = charState(ui.sel);

    if (act === 'close') { ui.popup?.complete?.(1); }
    else if (act === 'appraise') {
        const char = ui.chars.find(x => x.name === ui.sel);
        const data = char ? await appraiseChar(char) : await appraiseByName(ui.sel);
        if (data) { cs.appraised = true; cs.data = { ...data, items: normItems(data) }; cs.handedOver = false; cs.balance = sumCat(cs.data.items, '현금'); saveState(); render(); }
    }
    else if (act === 'appraiseall') {
        for (const n of selectableNames()) {
            const char = ui.chars.find(x => x.name === n);
            const data = char ? await appraiseChar(char) : await appraiseByName(n);
            if (data) { const c2 = charState(n); c2.appraised = true; c2.data = { ...data, items: normItems(data) }; c2.handedOver = false; c2.balance = sumCat(c2.data.items, '현금'); }
        }
        saveState(); render(); toastr.success('전체 감정 완료');
    }
    else if (act === 'addchar') {
        const v = (ui.$box.find('[data-act="newchar"]').val() || '').trim();
        if (!v) return;
        st.extraNames = st.extraNames || [];
        if (!st.extraNames.includes(v) && !ui.chars.find(x => x.name === v)) st.extraNames.push(v);
        ui.sel = v; saveState(); render();
    }
    else if (act === 'rmchar') {
        st.extraNames = (st.extraNames || []).filter(n => n !== ui.sel);
        delete st.chars[ui.sel];
        ui.sel = ui.chars[0]?.name || st.extraNames[0] || ui.sel;
        saveState(); render();
    }
    else if (act === 'appraiseuser') {
        const d = await appraiseUser();
        if (d) { st.userAssets = normItems(d); st.userData = { worth: d.worth, persona: d.persona, verdict: d.verdict }; saveState(); render(); }
    }
    else if (act === 'trash') { const i = +el.dataset.idx; if (cs.data?.items) { cs.data.items.splice(i, 1); saveState(); render(); } }
    else if (act === 'handover') {
        if (!cs.data) return;
        cs.data.items.forEach(m => st.vault.push({ ...m, from: ui.sel }));
        cs.handedDebt = null;
        const hd = cs.data.hidden_debt;
        if (hd && hd.value && Math.random() < 0.55) {
            const debt = { category: '빚', icon: hd.icon || '💸', name: hd.name || '딸려온 빚', value: hd.value, note: hd.note || '', debt: true };
            st.vault.push({ ...debt, from: ui.sel });
            cs.handedDebt = debt;
        }
        cs.handedOver = true; cs.balance = 0; cs.alba = null; saveState(); ui.tab = 'vault'; render();
        if (cs.handedDebt) toastr.warning(`어... ${ui.sel}의 빚도 딸려왔습니다.`, '💸', { timeOut: 6000 });
        else toastr.success(`${ui.sel}의 재산을 인수했습니다.`);
    }
    else if (act === 'returnall') {
        (st.vault || []).forEach(item => { if (item.from && item.from !== '내 것' && !item.debt) charState(item.from).balance += parseWon(item.value); });
        st.vault = []; saveState(); render();
    }
    else if (act === 'return') {
        const i = +el.dataset.idx, item = st.vault[i]; st.vault.splice(i, 1);
        if (item?.from && item.from !== '내 것') charState(item.from).balance += parseWon(item.value);
        saveState(); render();
    }
    else if (act === 'work') {
        const a = ensureAlba(cs), j = a.jobs[+el.dataset.idx]; if (!j) return;
        cs.balance += j.pay * 1e4; a.jobs.splice(+el.dataset.idx, 1);
        cs.workLog = [{ id: newWorkId(), ic: j.ic, n: j.n, pay: j.pay, note: j.note, incident: pickIncident(), sign: j.pay > 0 ? `+${j.pay}만원` : '±0', review: null }, ...(cs.workLog || [])].slice(0, 20);
        saveState(); render();
    }
    else if (act === 'reroll') {
        const a = ensureAlba(cs);
        if (a.resetAt && Date.now() < a.resetAt) return;
        if (a.rolls >= a.budget) { a.resetAt = Date.now() + COOLDOWN_MS; toastr.info(SNARK[Math.floor(Math.random() * SNARK.length)], '알바지옥'); saveState(); render(); return; }
        a.rolls += 1; a.jobs = rollPage(); saveState(); render();
    }
    else if (act === 'comparequip') {
        const list = appraisedList(); if (list.length < 2) return;
        ui.compareBusy = true; render();
        const topC = list[0], botC = list[list.length - 1];
        const tp = charState(topC.name).data?.persona || '';
        const bp = charState(botC.name).data?.persona || '';
        const prompt = `두 인물의 재산을 데드팬으로 비교하는 한두 줄을 쓴다. 위트있게, 각자 처지가 확 드러나게. 보고서체 금지, 캐주얼하게.
- 부자: "${topC.name}" (${topC.worth}), 성격: ${tp || '(없음)'}
- 빈자: "${botC.name}" (${botC.worth}), 성격: ${bp || '(없음)'}
느낌 예: "한 명은 가문 후계자. 한 명은 자전거 체인 빠지면 집에 못 감."
[출력] JSON 하나만, 코드펜스 없이: { "quip": "한두 줄 비교평" }`;
        let d = null;
        try { d = await llmJSON(prompt, 4096); } catch (e) { dbg('비교평 실패:', e?.message || String(e)); toastr.error('비교평 실패. 로그 확인.'); }
        ui.compareBusy = false;
        if (d?.quip) { st.compareQuip = d.quip; saveState(); }
        render();
    }
    else if (act === 'spend') {
        ui.spendBusy = ui.sel; render();
        const d = await genSpending(ui.sel);
        ui.spendBusy = null;
        if (d?.items) { cs.todaySpend = d.items.slice(0, 7); saveState(); }
        render();
    }
    else if (act === 'resetall') {
        if (!confirm('이 채팅의 전리품 데이터를 전부 초기화할까? (되돌릴 수 없음)')) return;
        const md = ctx().chatMetadata; if (md) delete md[KEY];
        ui.openLog = null; ui.spendBusy = null; ui.tab = 'appraise'; ui.sel = ui.chars[0]?.name || ui.sel;
        saveState(); render(); toastr.info('전리품 초기화 완료');
    }
    else if (act === 'clearlog') { cs.workLog = []; cs.dayReport = null; ui.openLog = null; saveState(); render(); }
    else if (act === 'dayreport') {
        if (!(cs.workLog || []).length) return;
        ui.dayBusy = true; render();
        const d = await genDayReport(ui.sel, cs.workLog);
        ui.dayBusy = false;
        if (d) { cs.dayReport = { timeline: d.timeline || [], diary: d.diary || '', resolve: d.resolve || '' }; saveState(); }
        render();
    }
    else if (act === 'daytoggle') { ui.dayOpen = !(ui.dayOpen !== false); render(); }
    else if (act === 'logopen') {
        const id = el.dataset.id, entry = (cs.workLog || []).find(x => String(x.id) === String(id)); if (!entry) return;
        if (String(ui.openLog) === String(entry.id)) { ui.openLog = null; render(); return; }
        ui.openLog = entry.id; render();
        if (!entry.review || !entry.review.scene) {
            const rv = await genReview(cs, entry);
            if (rv) { entry.review = { stars: Math.max(1, Math.min(5, parseInt(rv.stars) || 3)), before: rv.before || '', scene: rv.scene || '', mood: rv.mood || '', rn: rv.rn || '' }; saveState(); }
            if (String(ui.openLog) === String(entry.id)) render();
        }
    }
}
function onChange(e) { const el = e.target.closest('[data-act="pickchar"]'); if (el) { ui.sel = el.value; ui.openLog = null; render(); } }

setInterval(() => {
    if (!ui.$box || !ui.$box.is(':visible')) return;
    ui.$box.find('.sp-cdt').each(function () {
        const left = +this.dataset.reset - Date.now();
        if (left <= 0) { render(); return; }
        const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
        this.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    });
}, 1000);

// ── 패널 / 설정 / 버튼 ──
async function openPanel() {
    const c = ctx();
    if (!c.chatMetadata) { toastr.warning('채팅을 먼저 열어줘'); return; }
    const cands = candidateChars();
    if (!cands.length) { toastr.warning('캐릭터가 있는 채팅에서 열어줘'); return; }
    ui.chars = cands;
    ui.sel = (ui.sel && cands.find(x => x.name === ui.sel)) ? ui.sel : cands[0].name;
    ui.tab = 'appraise'; ui.openLog = null;
    const $box = $('<div class="spoils-app"></div>');
    ui.$box = $box; $box.on('click', onAction); $box.on('change', onChange);
    render();
    const popup = new c.Popup($box[0], c.POPUP_TYPE.DISPLAY, '', { wide: true, allowVerticalScrolling: true });
    ui.popup = popup;
    try { popup.dlg?.querySelectorAll?.('.popup-button-close, .popup_cross, [class*="close"]').forEach(el => el.remove()); } catch (e) { dbg('ST 닫기 제거 실패:', e?.message || e); }
    await popup.show();
}
function refreshProfiles(c) {
    const profiles = c.extensionSettings?.connectionManager?.profiles ?? [];
    $('#spoils_profile').html(['<option value="">— ST 전역 선택 프로필 사용 —</option>']
        .concat(profiles.map(p => `<option value="${p.id}">${esc(p.name || p.id)}</option>`)).join('')).val(c.extensionSettings?.spoils?.profileId ?? '');
}
function initSettings(c) {
    if (document.getElementById('spoils_settings')) return;
    c.extensionSettings.spoils = c.extensionSettings.spoils || { profileId: '' };
    $('#extensions_settings').append(`
      <div id="spoils_settings" class="spoils-settings"><div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header"><b>💰 전리품</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
        <div class="inline-drawer-content"><label id="spoils_profile_label" for="spoils_profile" style="cursor:pointer; user-select:none;">연결 프로필</label>
          <select id="spoils_profile" class="text_pole"></select>
          <small class="opacity50p">감정에 쓸 API. 비워두면 ST 전역 선택 프로필을 따라감.</small>
          <div style="margin-top:8px;"><input id="spoils_save" type="button" class="menu_button" value="저장"></div>
          <div id="spoils_logwrap" style="display:none; margin-top:10px;">
            <label>로그</label>
            <textarea id="spoils_log" class="text_pole" rows="8" readonly style="font-family:monospace; font-size:.8em;"></textarea>
            <div style="margin-top:6px;"><input id="spoils_log_copy" type="button" class="menu_button" value="복사"> <input id="spoils_log_clear" type="button" class="menu_button" value="로그 비우기"></div>
          </div>
        </div></div></div>`);
    refreshProfiles(c);
    $('#spoils_profile').on('change', function () { c.extensionSettings.spoils.profileId = $(this).val(); c.saveSettingsDebounced(); });
    $('#spoils_settings .inline-drawer-toggle').on('click', () => refreshProfiles(c));
    $('#spoils_save').on('click', () => { c.saveSettingsDebounced(); toastr.success('저장됐어', '💰 전리품'); });
    let tap = 0, tapT = 0;
    $('#spoils_profile_label').on('click', () => {
        const now = Date.now(); if (now - tapT > 1500) tap = 0; tapT = now; tap++;
        if (tap >= 5) {
            tap = 0;
            const w = $('#spoils_logwrap');
            if (w.is(':visible')) w.hide();
            else { $('#spoils_log').val(logBuf.join('\n') || '(비어있음)'); w.show(); toastr.info('🪵 로그 열림', '', { timeOut: 1500 }); }
        }
    });
    $('#spoils_log_clear').on('click', () => { logBuf.length = 0; $('#spoils_log').val(''); });
    $('#spoils_log_copy').on('click', async () => {
        const txt = logBuf.join('\n');
        try { await navigator.clipboard.writeText(txt); toastr.success('로그 복사됨'); }
        catch (e) { const ta = document.getElementById('spoils_log'); ta.removeAttribute('readonly'); ta.select(); try { document.execCommand('copy'); } catch (e2) { } ta.setAttribute('readonly', 'readonly'); toastr.success('로그 복사됨'); }
    });
    console.log(LOG, '설정 드로어 주입 완료');
}
function injectButton() {
    if (document.getElementById('spoils_button')) return;
    const $btn = $(`<div id="spoils_button" class="list-group-item flex-container flexGap5 interactable" tabindex="0" title="이 캐릭터의 자산을 감정/인수합니다"><div class="fa-solid fa-sack-dollar extensionsMenuExtensionButton"></div><span>전리품</span></div>`);
    $('#extensionsMenu').append($btn); $btn.on('click', openPanel);
    console.log(LOG, '버튼 주입 완료');
}
jQuery(() => {
    const c = SillyTavern.getContext();
    const tryInject = () => { $('#extensionsMenu').length ? injectButton() : setTimeout(tryInject, 500); };
    const trySettings = () => { $('#extensions_settings').length ? initSettings(c) : setTimeout(trySettings, 500); };
    tryInject(); trySettings();
});
