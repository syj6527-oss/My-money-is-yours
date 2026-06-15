// 💰 전리품 (Spoils) — v0.4.0
// 감정(카테고리 분리 + 물건 버리기) → 인수 → 금고 / 알바지옥. chat_metadata 채팅별 격리. 다인원 지원.

const LOG = '[전리품]';
const KEY = 'spoils';
const COOLDOWN_MS = 60 * 60 * 1000;
const CATS = ['현금', '예적금', '주식·투자', '부동산', '차량', '귀중품', '물건'];
const CAT_ICON = { '현금': '💵', '예적금': '🏦', '주식·투자': '📈', '부동산': '🏠', '차량': '🚗', '귀중품': '💎', '물건': '📦' };

// ── 금액 유틸 ──
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
function sumCat(items, cat) { return (items || []).filter(it => it.category === cat).reduce((s, it) => s + parseWon(it.value), 0); }
function sumAll(items) { return (items || []).reduce((s, it) => s + parseWon(it.value), 0); }

// ── 상태 (chat_metadata 채팅별 격리) ──
function getState() {
    const md = ctx().chatMetadata; if (!md) return null;
    if (!md[KEY]) md[KEY] = { vault: [], userAssets: [], userData: null, chars: {} };
    if (!md[KEY].userAssets) md[KEY].userAssets = [];
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

// ── 데이터 수집 + 감정 ──
function gatherCard(char) {
    return [char.name ? `이름: ${char.name}` : '', char.description, char.personality, char.scenario].filter(Boolean).join('\n').slice(0, 5000);
}
function gatherUserCard() {
    const c = ctx();
    const name = c.name1 || (c.substituteParams ? c.substituteParams('{{user}}') : '') || '유저';
    let persona = '';
    try { persona = c.substituteParams ? c.substituteParams('{{persona}}') : ''; } catch (e) { /* ignore */ }
    if (!persona) persona = c.powerUserSettings?.persona_description || '';
    return { name, card: `이름: ${name}\n${persona}`.trim() };
}
function gatherChat() {
    try { return (ctx().chat ?? []).slice(-50).map(m => `${m.name}: ${m.mes}`).join('\n').slice(0, 7000); } catch (e) { return ''; }
}
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
- 유저가 손에 쥘 수 있는 "자산"만 다룬다. (빚·부채는 이 목록의 관심사가 아니다.)
- 모든 자산은 items에 넣고 category로 분류한다: 현금 / 예적금 / 주식·투자 / 부동산 / 차량 / 귀중품 / 물건.
  현금·통장 잔액·주식도 각 category로. 소소한 소지품·잡동사니는 "물건"으로.
- 부유하면 값나가는 것을, "찐거지"라면 "물건" category에 거의 무가치한 잡동사니(0원)를 진지한 척 기재한다.
  (예: 어제 현장에서 묻혀온 모래 몇 줌(0원), 양말에 붙어온 나뭇가지 2개(0원))
- 금액(value/worth)은 숫자+통화 위주로. 비꼬는 부연은 note에, 금액 옆 괄호는 한두 단어로 짧게.
- note는 짧고 건조하게. persona는 성격+말투 한 줄 요약, 역시 건조하게.
- 세계관에 맞는 통화·단위. 대상/채팅과 같은 언어로. 불명확하면 한국어.

[출력] 아래 JSON 객체 하나만. 코드펜스·설명 없이.
{
  "tier": "부유" | "평범" | "빈털터리" | "찐거지",
  "income": { "monthly": "월수입", "source": "수입원" },
  "items": [ { "category": "현금|예적금|주식·투자|부동산|차량|귀중품|물건", "icon": "이모지", "name": "품목", "value": "가치", "note": "건조한 한 줄" } ],
  "worth": "추정 총액",
  "verdict": "한 줄 데드팬 총평",
  "persona": "성격 + 말투 한 줄 데드팬"
}

[대상: ${name}]
=== 카드 ===
${card || '(없음)'}
=== 로어북 ===
${lore || '(없음)'}
=== 최근 대화 ===
${chat || '(없음)'}`;
}

function parseResult(raw) {
    let s = String(raw ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a !== -1 && b > a) s = s.slice(a, b + 1);
    return JSON.parse(s);
}

async function runAppraisal(name, card, lore) {
    const c = ctx();
    const profileId = c.extensionSettings?.spoils?.profileId || c.extensionSettings?.connectionManager?.selectedProfile;
    if (!profileId) { toastr.warning('설정창(Extensions → 💰 전리품)에서 연결 프로필을 골라줘'); return null; }
    toastr.info(`${name} 감정 중…`, '💰 전리품', { timeOut: 0, tag: 'spoils' });
    try {
        const resp = await c.ConnectionManagerRequestService.sendRequest(profileId, buildPrompt(name, card, gatherChat(), lore), 4096);
        const raw = (typeof resp === 'string') ? resp : (resp?.content ?? '');
        console.log(LOG, '원문 응답:', raw);
        toastr.clear();
        return parseResult(raw);
    } catch (e) {
        toastr.clear(); console.error(LOG, '감정 실패', e);
        const msg = String(e?.message || e);
        if (/empty|candidate|safety|block/i.test(msg)) toastr.error('모델이 빈 응답을 반환했어. 연결 프로필 안전설정을 끄거나 토큰을 늘려봐.', '', { timeOut: 8000 });
        else toastr.error('감정 실패. 콘솔 확인.');
        return null;
    }
}
async function appraiseChar(char) { return runAppraisal(char.name, gatherCard(char), await gatherLore(char)); }
async function appraiseUser() { const u = gatherUserCard(); return runAppraisal(u.name, u.card, ''); }
function normItems(d) { return (d.items || []).map(it => ({ category: CATS.includes(it.category) ? it.category : '물건', icon: it.icon, name: it.name, value: it.value, note: it.note })); }

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
];
const SNARK = ['일이 그렇게 안 급한가 봐?', '골라잡을 처지는 아닐 텐데.', '오늘 치 일감은 동났어. 내일 다시 오든가.'];
function rollPage() { return [...JOB_POOL].sort(() => Math.random() - 0.5).slice(0, 3 + Math.floor(Math.random() * 3)); }
function ensureAlba(cs) {
    if (!cs.alba || (cs.alba.resetAt && Date.now() >= cs.alba.resetAt))
        cs.alba = { budget: 3 + Math.floor(Math.random() * 3), rolls: 0, jobs: rollPage(), resetAt: null };
    return cs.alba;
}

// ── 렌더 ──
const ui = { tab: 'appraise', sel: null, $box: null, chars: [] };

function assetLine(it, opts = {}) {
    const btn = opts.trash ? `<button class="sp-mini trash" data-act="trash" data-idx="${it._i}">🗑️ 버리기</button>`
        : opts.ret ? `<button class="sp-mini" data-act="return" data-idx="${it._i}">되돌려주기</button>` : '';
    return `<div class="sp-line ${parseWon(it.value) === 0 ? 'zero' : ''}">
      <span class="ic">${esc(it.icon || CAT_ICON[it.category] || '📦')}</span>
      <span class="nm">${esc(it.name)}${opts.from ? `<span class="sp-tag from">${esc(opts.from)}</span>` : ''}</span>
      <span class="vl">${esc(it.value)}</span>
      ${it.note ? `<span class="nt">${esc(it.note)}</span>` : ''}${btn}</div>`;
}
function renderSections(items, mode) {
    const g = {};
    (items || []).forEach((it, i) => { const c = CATS.includes(it.category) ? it.category : '물건'; (g[c] = g[c] || []).push({ ...it, _i: i }); });
    let html = '';
    CATS.forEach(cat => {
        const arr = g[cat]; if (!arr || !arr.length) return;
        const rows = arr.map(it => assetLine(it, { trash: mode === 'appraise' && cat === '물건', ret: mode === 'vault', from: mode === 'vault' ? it.from : null })).join('');
        html += `<div class="sp-cat"><div class="sp-cat-hd"><span>${CAT_ICON[cat]} ${cat}</span><span class="sp-cat-sum">${fmtWon(arr.reduce((s, it) => s + parseWon(it.value), 0))}</span></div>${rows}</div>`;
    });
    return html || '<div class="sp-empty">항목이 없습니다.</div>';
}

function render() {
    const st = getState(); if (!st || !ui.$box) return;
    const cs = charState(ui.sel);
    const tabs = `<div class="sp-tabs">
      <div class="sp-tab ${ui.tab === 'appraise' ? 'on' : ''}" data-tab="appraise">감정</div>
      <div class="sp-tab ${ui.tab === 'vault' ? 'on' : ''}" data-tab="vault">금고</div>
      <div class="sp-tab ${ui.tab === 'work' ? 'on' : ''}" data-tab="work">알바지옥</div></div>`;
    const body = ui.tab === 'appraise' ? renderAppraise(cs) : ui.tab === 'vault' ? renderVault(st) : renderWork(cs);
    ui.$box.html(`<div class="sp-hd"><span class="sp-logo">💰 전리품</span></div>${tabs}<div class="sp-body">${body}</div>`);
}
function charPicker() {
    return `<select class="sp-select" data-act="pickchar">${ui.chars.map(ch => `<option value="${esc(ch.name)}" ${ch.name === ui.sel ? 'selected' : ''}>${esc(ch.name)}</option>`).join('')}</select>`;
}
function charLabel() { return ui.chars.length > 1 ? charPicker() : `<span class="sp-charname">${esc(ui.sel)}</span>`; }

function renderAppraise(cs) {
    const multi = ui.chars.length > 1;
    const top = `<div class="sp-charbar">${charLabel()}<span class="sp-bar-btns">${multi ? '<button class="sp-btn ghost sm" data-act="appraiseall">전체 감정</button>' : ''}<button class="sp-btn sm" data-act="appraise">${cs.appraised ? '다시 감정' : '감정하기'}</button></span></div>`;
    let assets;
    if (cs.appraised && cs.data) {
        const d = cs.data;
        assets = `<div class="sp-card">
          <div class="sp-ttl">${esc(ui.sel)} 재산</div>
          <div class="sp-income"><span class="lbl">월수입</span><span class="r"><span class="amt">${esc(d.income?.monthly || '?')}</span><span class="src">${esc(d.income?.source || '')}</span></span></div>
          ${renderSections(d.items, 'appraise')}
          <div class="sp-total"><span class="lbl">추정 총액</span><span class="amt">${esc(d.worth || '?')}</span></div>
          ${cs.handedOver ? '<div class="sp-done">이미 인수 완료</div>' : '<div class="sp-handover"><button class="sp-btn" data-act="handover">재산 넘기기 ▾</button></div>'}
        </div>`;
    } else assets = `<div class="sp-empty">감정하기를 눌러 ${esc(ui.sel)}의 재산을 감정합니다.</div>`;

    let slip = '<div class="sp-card"><div class="sp-ttl">인수증</div><div class="sp-slip empty">아직 인수한 게 없습니다.</div></div>';
    if (cs.handedOver && cs.data) {
        const d = cs.data;
        const lines = (d.items || []).map(it => `<div class="sp-line"><span class="ic">${esc(it.icon || CAT_ICON[it.category] || '•')}</span><span class="nm">${esc(it.name)}</span><span class="vl">${esc(it.value)}</span></div>`).join('');
        slip = `<div class="sp-card"><div class="sp-ttl">인수증</div>
          <div class="sp-slip"><div class="sp-stamp">인 수 완 료</div>
            <div class="sp-sh"><div class="t">인수 명세서</div><div class="s">${esc(ui.sel)} → 귀하</div></div>
            ${lines}
            <div class="sp-total"><span class="lbl">인수 총액</span><span class="amt">${esc(d.worth || '?')}</span></div>
            <div class="sp-verdict">${esc(d.verdict || '')}</div>
            ${d.persona ? `<div class="sp-memo"><span class="memo-lbl">감정사 메모</span> ${esc(d.persona)}</div>` : ''}
          </div></div>`;
    }
    return top + assets + slip;
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
        <div class="sp-ttl">인수한 재산 <span class="sp-sub">${fmtWon(sumAll(trans))}</span></div>
        ${trans.length ? renderSections(trans, 'vault') : '<div class="sp-empty">인수한 재산이 없습니다.</div>'}
      </div>`;
}

function renderWork(cs) {
    const a = ensureAlba(cs);
    const waiting = a.resetAt && Date.now() < a.resetAt;
    const left = a.budget - a.rolls;
    let jobs;
    if (waiting) jobs = `<div class="sp-wait">전체 페이지 대기 중 — <span class="sp-cdt" data-reset="${a.resetAt}"></span> 후 리셋</div>`;
    else if (!a.jobs.length) jobs = `<div class="sp-empty">남은 일거리가 없습니다. 새 일거리를 굴려보세요.</div>`;
    else jobs = a.jobs.map((j, i) => `<div class="sp-job"><span class="ji">${esc(j.ic)}</span>
        <div class="jbody"><div class="jn">${esc(j.n)}</div><div class="jp">${j.pay > 0 ? '일당 ' + j.pay + '만원' : '무급'} · ${esc(j.note)}</div></div>
        <button class="sp-btn ghost sm" data-act="work" data-idx="${i}">일하기</button></div>`).join('');
    const logRows = (cs.workLog || []).length
        ? cs.workLog.map(r => `<div class="row"><span class="plus">${esc(r.sign)}</span> · ${esc(r.n)} <span class="dim">— ${esc(r.note)}</span></div>`).join('')
        : '<div class="empty-hint">아직 한 일이 없습니다.</div>';
    return `<div class="sp-charbar">${charLabel()}</div>
      <div class="sp-balance"><div class="lbl">${esc(ui.sel)} 잔액</div><div class="amt">${fmtWon(cs.balance)}</div></div>
      <div class="sp-card">
        <div class="sp-cardhead"><span class="sp-ttl">일거리 <span class="sp-budget">${waiting ? '소진' : '굴리기 ' + left + '회 남음'}</span></span>
          <button class="sp-btn ghost sm" data-act="reroll">🎲 새 일거리</button></div>
        <div class="sp-jobs">${jobs}</div><div class="sp-log">${logRows}</div></div>`;
}

// ── 액션 ──
async function onAction(e) {
    const el = e.target.closest('[data-act]');
    if (!el) { const tab = e.target.closest('.sp-tab'); if (tab) { ui.tab = tab.dataset.tab; render(); } return; }
    const act = el.dataset.act, st = getState(), cs = charState(ui.sel);

    if (act === 'appraise') {
        const data = await appraiseChar(ui.chars.find(x => x.name === ui.sel));
        if (data) { cs.appraised = true; cs.data = { ...data, items: normItems(data) }; cs.handedOver = false; cs.balance = sumCat(cs.data.items, '현금'); saveState(); render(); }
    }
    else if (act === 'appraiseall') {
        for (const ch of ui.chars) {
            const data = await appraiseChar(ch);
            if (data) { const c2 = charState(ch.name); c2.appraised = true; c2.data = { ...data, items: normItems(data) }; c2.handedOver = false; c2.balance = sumCat(c2.data.items, '현금'); }
        }
        saveState(); render(); toastr.success('전체 감정 완료');
    }
    else if (act === 'appraiseuser') {
        const d = await appraiseUser();
        if (d) { st.userAssets = normItems(d); st.userData = { worth: d.worth, persona: d.persona, verdict: d.verdict }; saveState(); render(); }
    }
    else if (act === 'trash') {
        const idx = +el.dataset.idx;
        if (cs.data?.items) { cs.data.items.splice(idx, 1); saveState(); render(); }
    }
    else if (act === 'handover') {
        if (!cs.data) return;
        cs.data.items.forEach(m => st.vault.push({ ...m, from: ui.sel }));
        cs.handedOver = true; cs.balance = 0; cs.alba = null;
        saveState(); ui.tab = 'vault'; render(); toastr.success(`${ui.sel}의 재산을 인수했습니다.`);
    }
    else if (act === 'return') {
        const idx = +el.dataset.idx, item = st.vault[idx];
        st.vault.splice(idx, 1);
        if (item?.from && item.from !== '내 것') charState(item.from).balance += parseWon(item.value);
        saveState(); render();
    }
    else if (act === 'work') {
        const a = ensureAlba(cs), j = a.jobs[+el.dataset.idx]; if (!j) return;
        cs.balance += j.pay * 1e4; a.jobs.splice(+el.dataset.idx, 1);
        cs.workLog = [{ sign: j.pay > 0 ? `+${j.pay}만원` : '±0', n: j.n, note: j.note }, ...(cs.workLog || [])].slice(0, 12);
        saveState(); render();
    }
    else if (act === 'reroll') {
        const a = ensureAlba(cs);
        if (a.resetAt && Date.now() < a.resetAt) return;
        if (a.rolls >= a.budget) { a.resetAt = Date.now() + COOLDOWN_MS; toastr.info(SNARK[Math.floor(Math.random() * SNARK.length)], '알바지옥'); saveState(); render(); return; }
        a.rolls += 1; a.jobs = rollPage(); saveState(); render();
    }
}
function onChange(e) { const el = e.target.closest('[data-act="pickchar"]'); if (el) { ui.sel = el.value; render(); } }

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
    ui.tab = 'appraise';
    const $box = $('<div class="spoils-app"></div>');
    ui.$box = $box; $box.on('click', onAction); $box.on('change', onChange);
    render();
    await c.callGenericPopup($box[0], c.POPUP_TYPE.DISPLAY, '', { wide: true, allowVerticalScrolling: true });
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
        <div class="inline-drawer-content"><label for="spoils_profile">연결 프로필</label>
          <select id="spoils_profile" class="text_pole"></select>
          <small class="opacity50p">감정에 쓸 API. 비워두면 ST 전역 선택 프로필을 따라감.</small>
        </div></div></div>`);
    refreshProfiles(c);
    $('#spoils_profile').on('change', function () { c.extensionSettings.spoils.profileId = $(this).val(); c.saveSettingsDebounced(); });
    $('#spoils_settings .inline-drawer-toggle').on('click', () => refreshProfiles(c));
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
