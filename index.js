// 💰 전리품 (Spoils) — 캐릭터 자산 감정 후 유저에게 "인수" 팝업
// v0.1.0

const LOG = '[전리품]';

// ──────────────────────────────────────────────
// 데이터 수집
// ──────────────────────────────────────────────
function gatherCard(ctx, char) {
    if (!char) return '';
    return [
        char.name ? `이름: ${char.name}` : '',
        char.description,
        char.personality,
        char.scenario,
    ].filter(Boolean).join('\n').slice(0, 5000);
}

function gatherChat(ctx) {
    try {
        const chat = ctx.chat ?? [];
        return chat.slice(-50)
            .map(m => `${m.name}: ${m.mes}`)
            .join('\n')
            .slice(0, 7000);
    } catch (e) {
        console.warn(LOG, 'chat 수집 실패', e);
        return '';
    }
}

async function gatherLore(ctx, char) {
    const names = new Set();
    try {
        const bound = char?.data?.extensions?.world;
        if (bound) names.add(bound);
        (ctx.selected_world_info ?? globalThis.selected_world_info ?? []).forEach(n => names.add(n));
        const chatLore = ctx.chatMetadata?.world_info ?? ctx.chat_metadata?.world_info;
        if (chatLore) names.add(chatLore);
    } catch (e) {
        console.warn(LOG, '로어북 이름 수집 실패', e);
    }

    let text = '';
    for (const name of names) {
        try {
            const data = await ctx.loadWorldInfo(name);
            if (data?.entries) {
                text += Object.values(data.entries)
                    .map(e => e.content)
                    .filter(Boolean)
                    .join('\n') + '\n';
            }
        } catch (e) {
            console.warn(LOG, 'loadWorldInfo 실패:', name, e);
        }
    }
    console.log(LOG, '로어북 수집:', names.size, '권 /', text.length, '자');
    return text.slice(0, 6000);
}

// ──────────────────────────────────────────────
// 프롬프트
// ──────────────────────────────────────────────
function buildPrompt({ card, chat, lore, name }) {
    return `넌 데드팬 유머 감각을 가진 재산 감정사다. 아래 캐릭터 정보를 읽고, 유저가 이 캐릭터로부터 지금 "인수"하게 될 자산 목록을 작성한다.

[원칙]
- 채팅·로어북·카드에 실제로 등장한 소지품과 재산은 그대로 반영한다.
- 비어있는 부분은 캐릭터의 처지·성격·세계관에 어울리게 그럴듯하게 채워 지어낸다.
- 유저가 손에 쥘 수 있는 "자산"만 다룬다. (부채·빚은 이 목록의 관심사가 아니다.)
- 부유하면 실제로 값나가는 것을, 빈털터리면 거의 무가치한 잡동사니를 진지한 척 기재한다.
  (예: 어제 주운 바스라진 나뭇잎, 한쪽만 남은 양말, 미지근한 물 반 병)
- note는 짧고 건조하게. 감정 묘사 대신 사실만, 살짝 비꼬는 톤.
- 통화·단위는 세계관에 맞춰서.
- 캐릭터/채팅과 같은 언어로 작성. 불명확하면 한국어.

[출력] 아래 JSON 객체 하나만 출력한다. 코드펜스·설명·다른 텍스트는 붙이지 않는다.
{
  "tier": "부유" | "평범" | "빈털터리",
  "worth": "추정 총액 (세계관 통화 문자열)",
  "verdict": "한 줄 데드팬 총평",
  "items": [
    { "icon": "이모지 1개", "name": "품목명", "value": "가치 문자열", "note": "건조한 한 줄" }
  ]
}

[대상: ${name || '미상'}]
=== 캐릭터 카드 ===
${card || '(없음)'}

=== 로어북 ===
${lore || '(없음)'}

=== 최근 대화 ===
${chat || '(없음)'}`;
}

// ──────────────────────────────────────────────
// 응답 파싱
// ──────────────────────────────────────────────
function parseResult(raw) {
    let s = String(raw ?? '').trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    // 본문 어딘가의 첫 { ~ 마지막 } 추출
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a !== -1 && b !== -1 && b > a) s = s.slice(a, b + 1);
    return JSON.parse(s);
}

// ──────────────────────────────────────────────
// 렌더
// ──────────────────────────────────────────────
function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function renderReceipt(data, name) {
    const tierClass = { '부유': 'rich', '평범': 'mid', '빈털터리': 'broke' }[data.tier] || 'mid';
    const rows = (data.items ?? []).map(it => `
        <div class="spoils-row">
            <span class="spoils-ico">${escapeHtml(it.icon || '•')}</span>
            <span class="spoils-name">${escapeHtml(it.name)}</span>
            <span class="spoils-val">${escapeHtml(it.value)}</span>
            <span class="spoils-note">${escapeHtml(it.note)}</span>
        </div>`).join('');

    return `
    <div class="spoils-receipt tier-${tierClass}">
        <div class="spoils-head">
            <div class="spoils-title">인수 명세서</div>
            <div class="spoils-sub">${escapeHtml(name || '미상')} → 귀하</div>
        </div>
        <div class="spoils-worth">
            <span>추정 총액</span>
            <strong>${escapeHtml(data.worth || '?')}</strong>
        </div>
        <div class="spoils-list">${rows || '<div class="spoils-row">(인수할 것이 없습니다)</div>'}</div>
        <div class="spoils-verdict">${escapeHtml(data.verdict || '')}</div>
    </div>`;
}

// ──────────────────────────────────────────────
// 메인 흐름
// ──────────────────────────────────────────────
async function onLootClick() {
    const ctx = SillyTavern.getContext();

    const profileId = ctx.extensionSettings?.spoils?.profileId
        || ctx.extensionSettings?.connectionManager?.selectedProfile;
    if (!profileId) {
        toastr.warning('설정창(Extensions → 💰 전리품)에서 연결 프로필을 골라줘');
        return;
    }

    const char = ctx.characters?.[ctx.characterId];
    const name = char?.name;
    if (!char) {
        toastr.warning('캐릭터가 선택돼 있어야 인수할 게 있지');
        return;
    }

    toastr.info('재산 감정 중…', '💰 전리품', { timeOut: 0, extendedTimeOut: 0, tag: 'spoils' });

    try {
        const [card, chat, lore] = [gatherCard(ctx, char), gatherChat(ctx), await gatherLore(ctx, char)];
        const prompt = buildPrompt({ card, chat, lore, name });

        const resp = await ctx.ConnectionManagerRequestService.sendRequest(profileId, prompt, 1500);
        const raw = (typeof resp === 'string') ? resp : (resp?.content ?? '');
        console.log(LOG, '원문 응답:', raw);

        toastr.clear();

        let data;
        try {
            data = parseResult(raw);
        } catch (e) {
            console.error(LOG, 'JSON 파싱 실패', e, raw);
            toastr.error('감정서 형식이 깨졌어. 콘솔 확인.');
            return;
        }

        await ctx.callGenericPopup(renderReceipt(data, name), ctx.POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
    } catch (e) {
        toastr.clear();
        console.error(LOG, '실패', e);
        toastr.error('감정 실패. 콘솔 확인.');
    }
}

// ──────────────────────────────────────────────
// 설정 드로어 (Extensions 패널 → 연결 프로필)
// ──────────────────────────────────────────────
function refreshProfiles(ctx) {
    const profiles = ctx.extensionSettings?.connectionManager?.profiles ?? [];
    const cur = ctx.extensionSettings?.spoils?.profileId ?? '';
    const opts = ['<option value="">— ST 전역 선택 프로필 사용 —</option>']
        .concat(profiles.map(p => `<option value="${p.id}">${$('<i>').text(p.name || p.id).html()}</option>`));
    $('#spoils_profile').html(opts.join('')).val(cur);
}

function initSettings(ctx) {
    if (document.getElementById('spoils_settings')) return;
    ctx.extensionSettings.spoils = ctx.extensionSettings.spoils || { profileId: '' };

    const html = `
    <div id="spoils_settings" class="spoils-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>💰 전리품</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <label for="spoils_profile">연결 프로필</label>
          <select id="spoils_profile" class="text_pole"></select>
          <small class="opacity50p">감정에 쓸 API. 비워두면 ST 전역 선택 프로필을 따라감.</small>
        </div>
      </div>
    </div>`;

    $('#extensions_settings').append(html);
    refreshProfiles(ctx);

    $('#spoils_profile').on('change', function () {
        ctx.extensionSettings.spoils.profileId = $(this).val();
        ctx.saveSettingsDebounced();
        console.log(LOG, '프로필 설정:', $(this).val() || '(전역)');
    });
    // 드로어 열 때마다 프로필 목록 최신화 (나중에 추가된 프로필 반영)
    $('#spoils_settings .inline-drawer-toggle').on('click', () => refreshProfiles(ctx));
    console.log(LOG, '설정 드로어 주입 완료');
}

// ──────────────────────────────────────────────
// 버튼 주입
// ──────────────────────────────────────────────
function injectButton() {
    if (document.getElementById('spoils_button')) return;
    const $btn = $(`
        <div id="spoils_button" class="list-group-item flex-container flexGap5 interactable" tabindex="0" title="이 캐릭터의 자산을 인수합니다">
            <div class="fa-solid fa-sack-dollar extensionsMenuExtensionButton"></div>
            <span>전리품 인수</span>
        </div>`);
    $('#extensionsMenu').append($btn);
    $btn.on('click', onLootClick);
    console.log(LOG, '버튼 주입 완료');
}

jQuery(() => {
    // extensionsMenu가 늦게 뜨는 경우 대비해 약간 지연
    const tryInject = () => {
        if ($('#extensionsMenu').length) injectButton();
        else setTimeout(tryInject, 500);
    };
    tryInject();

    const ctx = SillyTavern.getContext();
    const trySettings = () => {
        if ($('#extensions_settings').length) initSettings(ctx);
        else setTimeout(trySettings, 500);
    };
    trySettings();
});
