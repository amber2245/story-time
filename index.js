(() => {
  "use strict";

  const EXT_ID = "story_time";

  // 你要的模式：先出char回复，再结算时间
  const ADVANCE_MODE = "assistant_only"; // assistant_only | both | user_only

const STABLE_CHECK_INTERVAL = 500; // ms
const STABLE_CONFIRM_COUNT = 3;    // 连续3次文本不变才算稳定
const STABLE_MAX_WAIT = 15000;     // 最长等待15秒

// 新增：assistant最小稳定要求，避免“...”或太短文本被提前结算
const ASSISTANT_MIN_SETTLE_WAIT = 2200; // 至少等2.2秒
const ASSISTANT_MIN_CONTENT_LEN = 12;   // 至少12字再结算（可按你习惯调）

  const FESTIVALS = {
    "1-1": "元旦",
    "2-14": "情人节",
    "6-1": "儿童节",
    "10-1": "国庆节",
    "10-31": "万圣节",
    "12-25": "圣诞节",
    "12-31": "跨年夜"
  };

  const DEFAULT_STATE = {
    year: 1,
    month: 1,
    day: 1,
    minutes: 7 * 60 + 30,
    weather: "晴",
    autoWeather: true,
    lastDeltaMinutes: 0,
    lastDeltaReason: "",
    lastTriggerText: "",
    lastTransitionLabel: ""
  };

  let state = { ...DEFAULT_STATE };
  let chatKey = "";
  let barEl = null;
  let currentChatEl = null;
  let chatObserver = null;
  const processedMes = new WeakSet();
  const pendingStableCheck = new WeakMap();

  // ---------- 基础 ----------
  function getContextSafe() {
    try {
      if (window.SillyTavern?.getContext) return window.SillyTavern.getContext();
      if (window.getContext) return window.getContext();
    } catch (_) {}
    return null;
  }

  function getChatKey() {
    const ctx = getContextSafe();
    const candidates = [
      ctx?.chatId,
      ctx?.chat_id,
      ctx?.groupId,
      ctx?.group_id,
      ctx?.characterId,
      ctx?.character_id,
      ctx?.selected_character,
      ctx?.this_chid,
      ctx?.name2
    ];

    for (const value of candidates) {
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        return `${EXT_ID}:${String(value)}`;
      }
    }

    const path = window.location?.hash || window.location?.pathname || "global";
    return `${EXT_ID}:${path}`;
  }

  function loadState() {
    const raw = localStorage.getItem(chatKey);
    if (!raw) {
      state = { ...DEFAULT_STATE };
      return;
    }
    try {
      state = { ...DEFAULT_STATE, ...JSON.parse(raw) };
    } catch (_) {
      state = { ...DEFAULT_STATE };
    }
  }

  function saveState() {
    localStorage.setItem(chatKey, JSON.stringify(state));
  }

  function daysInMonth(year, month) {
    if (month === 2) return 28;
    if ([4, 6, 9, 11].includes(month)) return 30;
    return 31;
  }

  function rollWeather(month) {
    let pool;
    if ([3, 4, 5].includes(month)) pool = ["晴", "晴", "多云", "阴", "小雨", "雾"];
    else if ([6, 7, 8].includes(month)) pool = ["晴", "多云", "阴", "小雨", "中雨", "雷阵雨"];
    else if ([9, 10, 11].includes(month)) pool = ["晴", "晴", "多云", "阴", "小雨", "雾"];
    else pool = ["晴", "多云", "阴", "小雨", "雪", "雾"];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function advanceOneDay() {
    state.day += 1;
    if (state.day > daysInMonth(state.year, state.month)) {
      state.day = 1;
      state.month += 1;
      if (state.month > 12) {
        state.month = 1;
        state.year += 1;
      }
    }
    if (state.autoWeather) state.weather = rollWeather(state.month);
  }

  function backOneDay() {
    if (state.year === 1 && state.month === 1 && state.day === 1) return;
    state.day -= 1;
    if (state.day < 1) {
      state.month -= 1;
      if (state.month < 1) {
        state.month = 12;
        state.year = Math.max(1, state.year - 1);
      }
      state.day = daysInMonth(state.year, state.month);
    }
  }

  function shiftDate(days) {
    if (days > 0) {
      for (let i = 0; i < days; i++) advanceOneDay();
    }
    if (days < 0) {
      for (let i = 0; i < Math.abs(days); i++) backOneDay();
    }
  }

  function normalizeTime() {
    let dayShift = 0;
    while (state.minutes >= 1440) {
      state.minutes -= 1440;
      dayShift += 1;
    }
    while (state.minutes < 0) {
      state.minutes += 1440;
      dayShift -= 1;
    }
    if (dayShift !== 0) shiftDate(dayShift);
  }

  function hhmm(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  function getFestival() {
    return FESTIVALS[`${state.month}-${state.day}`] || "";
  }

  function getPhase(mins) {
    if (mins < 300) return "深夜";
    if (mins < 480) return "清晨";
    if (mins < 720) return "上午";
    if (mins < 840) return "中午";
    if (mins < 1080) return "下午";
    if (mins < 1260) return "傍晚";
    return "夜晚";
  }

  function getMealHint(mins) {
    if (mins >= 360 && mins <= 540) return "早餐时段";
    if (mins >= 690 && mins <= 810) return "午餐时段";
    if (mins >= 1050 && mins <= 1230) return "晚餐时段";
    if (mins >= 1380 || mins <= 300) return "休息/睡眠时段";
    return "普通活动时段";
  }

  function formatDelta(minutes) {
    if (!minutes) return "无";
    const abs = Math.abs(minutes);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    const sign = minutes > 0 ? "+" : "-";
    if (h > 0 && m > 0) return `${sign}${h}小时${m}分钟`;
    if (h > 0) return `${sign}${h}小时`;
    return `${sign}${m}分钟`;
  }

  function buildTransitionLabel(delta, reason) {
    const phase = getPhase(state.minutes);
    if (delta >= 300 || reason === "sleep") {
      if (phase === "清晨") return "第二天清晨";
      if (phase === "上午") return "第二天早上";
      if (phase === "中午") return "第二天中午";
      if (phase === "下午") return "第二天下午";
      if (phase === "傍晚") return "第二天傍晚";
      return `第二天${phase}`;
    }
    if (delta >= 120) {
      if (phase === "清晨" || phase === "上午") return "数小时后，已近早晨";
      if (phase === "中午") return "数小时后，已到中午";
      if (phase === "下午") return "数小时后，天色已亮";
      if (phase === "傍晚") return "数小时后，已近傍晚";
      return `数小时后，已是${phase}`;
    }
    if (delta >= 30) {
      return `${phase}稍晚些时候`;
    }
    return "";
  }

  function commitState() {
    saveState();
    renderBar();
    refreshModelState();
  }

  function recordTransition(delta, reason, text) {
    state.lastDeltaMinutes = delta || 0;
    state.lastDeltaReason = reason || "";
    state.lastTriggerText = (text || "").slice(0, 120);
    state.lastTransitionLabel = buildTransitionLabel(delta || 0, reason || "");
  }

  // ---------- UI ----------
  function renderBar() {
    if (!barEl) return;
    const timeEl = barEl.querySelector("#st-story-clock-time");
    const metaEl = barEl.querySelector("#st-story-clock-meta");
    if (timeEl) timeEl.textContent = hhmm(state.minutes);

    const festival = getFestival();
    const meta = `${state.month}月${state.day}日 · ${state.weather}${festival ? ` · ${festival}` : ""}`;
    if (metaEl) metaEl.textContent = meta;
  }

  function bindBarEvents() {
    if (!barEl || barEl.dataset.bound === "1") return;
    barEl.dataset.bound = "1";

    barEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".st-story-clock-btn");
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === "+10") {
        recordTransition(10, "manual", "手动调整");
        applyDelta(10);
      }
      if (act === "-10") {
        recordTransition(-10, "manual", "手动调整");
        applyDelta(-10);
      }
      if (act === "settings") openSettings();
    });
  }

  function ensureBar() {
    const chat = document.querySelector("#chat");
    if (!chat) {
      barEl = null;
      return;
    }

    if (barEl && chat.contains(barEl)) {
      bindBarEvents();
      renderBar();
      return;
    }

    const existing = chat.querySelector("#st-story-clock-bar");
    if (existing) {
      barEl = existing;
      bindBarEvents();
      renderBar();
      return;
    }

    barEl = document.createElement("div");
    barEl.id = "st-story-clock-bar";
    barEl.innerHTML = `
      <div>
        <div id="st-story-clock-time">--:--</div>
        <div id="st-story-clock-meta">1月1日 · 晴</div>
      </div>
      <div id="st-story-clock-controls">
        <button class="st-story-clock-btn" data-act="-10">-10m</button>
        <button class="st-story-clock-btn" data-act="+10">+10m</button>
        <button class="st-story-clock-btn" data-act="settings">⚙</button>
      </div>
    `;
    chat.prepend(barEl);

    bindBarEvents();
    renderBar();
  }

  // ---------- Prompt 注入 ----------
  function setExtensionPrompt(prompt) {
    const ctx = getContextSafe();
    if (!ctx) return false;

    let ok = false;

    try {
      if (ctx.extensionPrompts) {
        ctx.extensionPrompts[EXT_ID] = {
          value: prompt,
          position: 0,
          depth: 1,
          scan: false,
          role: 0
        };
        ok = true;
      }
    } catch (err) {
      console.warn("[Story Time] direct extensionPrompts write failed:", err);
    }

    try {
      if (typeof ctx.setExtensionPrompt === "function") {
        ctx.setExtensionPrompt(EXT_ID, prompt, 0, 1);
        ok = true;
      }
    } catch (err) {
      console.warn("[Story Time] setExtensionPrompt failed:", err);
    }

    return ok;
  }

  function buildPrompt() {
    const festival = getFestival();
    const deltaText = formatDelta(state.lastDeltaMinutes);
    const recentJump = state.lastDeltaMinutes >= 30;
    const recentBigJump = state.lastDeltaMinutes >= 120;
    const weatherIsImportant = /小雨|中雨|雷阵雨|雪|雾/.test(state.weather);
    const festivalIsImportant = Boolean(festival) && /情人节|圣诞节|元旦|跨年夜/.test(festival);

    const dynamicRules = [];

    if (recentJump) {
      dynamicRules.push("最近发生了明显时间推进，请在正文开头或前半段自然体现时段变化。");
    } else {
      dynamicRules.push("最近没有明显时间跳跃，不要刻意反复强调当前时段。");
    }

    if (recentBigJump || state.lastDeltaReason === "sleep") {
      dynamicRules.push("若刚经历睡眠、过夜或数小时跳时，可使用“第二天清晨”“数小时后”“天已经亮了”等表达。");
    }

    if (weatherIsImportant) {
      dynamicRules.push("当前天气对环境和行动有实际影响，可在需要时体现体感、声音、地面、视线或出行准备。");
    } else {
      dynamicRules.push("天气作为背景常识即可，除非场景需要，否则不要每轮都提。");
    }

    if (festivalIsImportant) {
      dynamicRules.push("节日只在互动、气氛或安排确实相关时再提，不要机械重复节日本身。");
    } else {
      dynamicRules.push("日期和节日通常保持为背景信息，不必主动反复提及。");
    }

    return `[剧情状态]
- 当前时间: ${hhmm(state.minutes)}（${getPhase(state.minutes)}）
- 当前日期: ${state.month}月${state.day}日
- 当前天气: ${state.weather}
- 当前节日: ${festival || "无"}
- 当前时段倾向: ${getMealHint(state.minutes)}
- 最近时间变化: ${deltaText}
- 最近变化原因: ${state.lastDeltaReason || "无"}
- 最近触发内容: ${state.lastTriggerText || "无"}
- 建议表现: ${state.lastTransitionLabel || "无需特别强调"}

[写作原则]
1. 始终知晓当前时间、天气、日期和节日，并让角色行为、作息和环境符合这些状态。
2. 不要每次回复都重复提及时间、天气或节日；只有当它们正在影响场景、行为、情绪、光线、体感、安排时，才自然表现出来。
3. 若上一条已经明显表现过时段、天气或节日，本条除非剧情有新变化，否则应收敛，不要机械复读。
4. 时间信息优先影响作息与行动逻辑，例如早晨适合苏醒、洗漱、早餐、出门准备；中午适合午餐与日照最亮；傍晚适合暮色、归家、晚餐；深夜适合安静、困意与休息。
5. 天气信息优先影响环境、声音、光线、体感与出行准备，例如下雨可能带来雨声、潮气、湿地面、带伞需求，但不必每轮都写。
6. 节日信息默认只是背景，不要把它当作每条都必须出现的主题；只有当人物真的会因此改变安排、情绪或互动时，再体现出来。
7. 除非剧情明确再次发生时间跳跃，否则不要擅自额外大幅改变时间。

[本轮额外提醒]
- ${dynamicRules.join("\n- ")}`;
  }

  function refreshModelState() {
    const prompt = buildPrompt();
    const ok = setExtensionPrompt(prompt);
    const ctx = getContextSafe();

    window.storyTimeDebug = {
      chatKey,
      state: { ...state },
      prompt,
      injected: ok,
      extensionPromptEntry: ctx?.extensionPrompts?.[EXT_ID] || null
    };
  }

  // ---------- 时间逻辑 ----------
  function applyDelta(delta) {
    if (!delta || Number.isNaN(delta)) return;
    state.minutes += delta;
    normalizeTime();
    commitState();
  }

  function setAbsoluteTime(h, m, reason = "absolute_time", text = "") {
    const oldMinutes = state.minutes;
    state.minutes = h * 60 + m;
    normalizeTime();
    recordTransition(state.minutes - oldMinutes, reason, text);
    commitState();
  }

  function hashText(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function pickRange(min, max, seed = "") {
    if (max <= min) return min;
    return min + (hashText(seed) % (max - min + 1));
  }

  function parseCNNumber(str) {
    if (!str) return NaN;
    if (/^\d+$/.test(str)) return parseInt(str, 10);
    if (str === "半") return 0.5;

    const map = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (map[str] != null) return map[str];
    if (str === "十") return 10;

    if (str.includes("十")) {
      const parts = str.split("十");
      const tens = parts[0] ? (map[parts[0]] || 0) : 1;
      const ones = parts[1] ? (map[parts[1]] || 0) : 0;
      return tens * 10 + ones;
    }

    return NaN;
  }

  function tryParseAbsoluteTime(text) {
    let m = text.match(/([01]?\d|2[0-3])[:：]([0-5]\d)/);
    if (m) {
      setAbsoluteTime(parseInt(m[1], 10), parseInt(m[2], 10), "absolute_time", text);
      return true;
    }

    m = text.match(/([01]?\d|2[0-3])\s*点\s*([0-5]?\d)?\s*分?/);
    if (m) {
      setAbsoluteTime(parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0, "absolute_time", text);
      return true;
    }
    return false;
  }

  function tryParsePeriodAnchor(text) {
    let touched = false;
    let movedDays = 0;

    if (/(第二天|次日|翌日|隔天)/.test(text)) {
      shiftDate(1);
      movedDays = 1;
      touched = true;
    }

    const m = text.match(/(到了|已是|现在是|此时|时间来到).{0,4}(清晨|早上|上午|中午|下午|傍晚|晚上|深夜|凌晨)/);
    if (m) {
      const period = m[2];
      const map = {
        "凌晨": 2 * 60,
        "深夜": 1 * 60,
        "清晨": 6 * 60 + 30,
        "早上": 7 * 60 + 30,
        "上午": 9 * 60,
        "中午": 12 * 60,
        "下午": 15 * 60,
        "傍晚": 18 * 60,
        "晚上": 20 * 60
      };
      state.minutes = map[period] ?? state.minutes;
      touched = true;
    }

    if (touched) {
      normalizeTime();
      recordTransition(movedDays > 0 ? movedDays * 1440 : 60, "period_anchor", text);
      commitState();
      return true;
    }

    return false;
  }

  function parseExplicitDuration(text) {
    let minutes = 0;
    let hit = false;

    for (const m of text.matchAll(/([一二两三四五六七八九十半\d]+)\s*小时(?:后|之后|左右|内)?/g)) {
      const n = parseCNNumber(m[1]);
      if (!Number.isNaN(n)) {
        minutes += Math.round(n * 60);
        hit = true;
      }
    }

    for (const m of text.matchAll(/([一二两三四五六七八九十\d]+)\s*分钟(?:后|之后|左右|内)?/g)) {
      const n = parseCNNumber(m[1]);
      if (!Number.isNaN(n)) {
        minutes += Math.round(n);
        hit = true;
      }
    }

    if (/半个?小时/.test(text)) {
      minutes += 30;
      hit = true;
    }
    if (/一刻钟/.test(text)) {
      minutes += 15;
      hit = true;
    }
    if (/两刻钟/.test(text)) {
      minutes += 30;
      hit = true;
    }

    return { minutes, hit };
  }

  const CATEGORY_RULES = [
    { name: "meal", reg: /(吃(完|过|了)?(饭|早餐|早饭|午饭|中饭|午餐|晚饭|晚餐|宵夜)?|用餐|进餐)/, range: [18, 45], reason: "meal" },
    { name: "cook", reg: /(做饭|下厨|烹饪|备餐|准备.*(饭|餐))/, range: [20, 50], reason: "cook" },
    { name: "hygiene", reg: /(洗漱|刷牙|洗脸|梳洗|化妆|整理仪容|打理自己)/, range: [8, 20], reason: "hygiene" },
    { name: "dress", reg: /(换(好)?衣服|更衣|穿好衣服|穿戴整齐)/, range: [6, 15], reason: "dress" },
    { name: "commute", reg: /(出门|赶路|通勤|坐车|开车|乘车|打车|地铁|公交|骑车|步行前往|前往)/, range: [12, 45], reason: "commute" },
    { name: "work_study", reg: /(上课|工作|学习|开会|训练|写作业|值班|处理文件)/, range: [35, 120], reason: "work_study" },
    { name: "social", reg: /(约会|聚会|会面|拜访|长谈|闲聊了一会|聊了很久)/, range: [15, 60], reason: "social" },
    { name: "shopping", reg: /(购物|采购|逛街|商场|买菜)/, range: [20, 90], reason: "shopping" },
    { name: "exercise", reg: /(跑步|锻炼|健身|打球|游泳|运动)/, range: [20, 80], reason: "exercise" },
    { name: "rest", reg: /(休息|小憩|午睡|躺一会|闭目养神)/, range: [10, 50], reason: "rest" },
    { name: "sleep", reg: /(睡觉|入睡|睡着|过夜|补觉)/, range: [360, 540], reason: "sleep" },
    { name: "medical", reg: /(包扎|治疗|看医生|就诊|输液|护理)/, range: [20, 90], reason: "medical" }
  ];

  function estimateCategoryMinutes(text) {
    let minutes = 0;
    let count = 0;
    let mainReason = "";

    for (const rule of CATEGORY_RULES) {
      if (!rule.reg.test(text)) continue;
      count += 1;

      let min = rule.range[0];
      let max = rule.range[1];

      if (rule.name === "meal") {
        const current = state.minutes;
        if (current >= 330 && current <= 570) { min = 15; max = 30; }
        else if (current >= 660 && current <= 870) { min = 25; max = 45; }
        else if (current >= 1020 && current <= 1260) { min = 30; max = 55; }
      }

      minutes += pickRange(min, max, `${text}|${rule.name}|${state.minutes}`);
      if (!mainReason) mainReason = rule.reason;
    }

    return { minutes, count, reason: mainReason };
  }

  function estimateNarrativeMinutes(text) {
    let n = 0;
    let reason = "";

    if (/(不知不觉(间)?|转眼(间)?|一晃|过了许久|良久)/.test(text)) {
      n += pickRange(10, 30, text + "|flow_strong");
      reason = reason || "narrative_flow";
    }

    if (/(过了一会儿?|过了一阵子?|片刻后|随后|接着|然后|不久后)/.test(text)) {
      n += pickRange(3, 12, text + "|flow_mid");
      reason = reason || "narrative_flow";
    }

    if (/(天色渐暗|夜幕降临|天亮了|日出|日落|黄昏|傍晚时分)/.test(text)) {
      n += pickRange(20, 70, text + "|scene_daylight");
      reason = reason || "scene_shift";
    }

    if (/(外面|窗外).*(下起|开始下).*(雨|雪)|雨越下越大|突然下雨/.test(text)) {
      n += pickRange(6, 20, text + "|scene_weather_shift");
      reason = reason || "scene_shift";
    }

    return { minutes: n, reason };
  }

  function estimateFallbackMinutes(text) {
    const clean = text.replace(/\s+/g, "");
    const len = clean.length;
    let base = 1;

    if (len <= 6) base = 1;
    else if (len <= 25) base = 2;
    else if (len <= 80) base = 3;
    else base = 4;

    const jitter = hashText(clean) % 2;
    return base + jitter;
  }

  function estimateMinutesByText(text) {
    if (!text) return { delta: 0, reason: "" };

    const explicit = parseExplicitDuration(text);
    const category = estimateCategoryMinutes(text);
    const narrative = estimateNarrativeMinutes(text);

    let total = 0;
    let reason = "";

    if (explicit.hit) {
      total = explicit.minutes + Math.round((category.minutes + narrative.minutes) * 0.35);
      reason = "explicit_duration";
    } else {
      total = category.minutes + narrative.minutes;
      reason = category.reason || narrative.reason || "";

      if (category.count >= 2 && total > 0) {
        const factor = 1 + Math.min(0.35, (category.count - 1) * 0.1);
        total = Math.round(total * factor);
      }
    }

    if (total <= 0) {
      total = estimateFallbackMinutes(text);
      reason = "fallback_chat";
    }

    return {
      delta: Math.min(total, 360),
      reason: reason || "generic_progress"
    };
  }

  function tryParseDate(text) {
    const m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
    if (!m) return false;
    const mm = parseInt(m[1], 10);
    const dd = parseInt(m[2], 10);
    if (mm < 1 || mm > 12) return false;
    if (dd < 1 || dd > daysInMonth(state.year, mm)) return false;

    state.month = mm;
    state.day = dd;
    commitState();
    return true;
  }

  function tryParseWeather(text) {
    let next = "";
    if (/雷阵雨|打雷/.test(text)) next = "雷阵雨";
    else if (/暴雨|大雨/.test(text)) next = "中雨";
    else if (/小雨|下雨|雨天/.test(text)) next = "小雨";
    else if (/下雪|雪天/.test(text)) next = "雪";
    else if (/多云/.test(text)) next = "多云";
    else if (/阴天|天阴/.test(text)) next = "阴";
    else if (/大雾|起雾|雾天/.test(text)) next = "雾";
    else if (/晴天|天晴|阳光明媚/.test(text)) next = "晴";

    if (!next || next === state.weather) return false;
    state.weather = next;
    commitState();
    return true;
  }

  // ---------- 角色识别 & 稳定结算 ----------
  function parseBoolFlag(v) {
    if (v === true || v === "true" || v === 1 || v === "1") return true;
    if (v === false || v === "false" || v === 0 || v === "0") return false;
    return null;
  }

  function getMesRole(mesEl) {
    if (!mesEl) return "unknown";

    const raw =
      mesEl.getAttribute("is_user") ??
      mesEl.dataset?.isUser ??
      mesEl.dataset?.is_user;

    const flag = parseBoolFlag(raw);
    if (flag === true) return "user";
    if (flag === false) return "assistant";

    if (mesEl.classList?.contains("system_mes")) return "system";
    if (mesEl.classList?.contains("user_mes") || mesEl.classList?.contains("mes_user")) return "user";

    const name =
      mesEl.querySelector(".name_text")?.textContent?.trim() ||
      mesEl.querySelector(".mes_name")?.textContent?.trim() ||
      "";

    const ctx = getContextSafe();
    if (name && ctx?.name1 && name === ctx.name1) return "user";
    if (name && ctx?.name2 && name === ctx.name2) return "assistant";

    return "unknown";
  }

  function shouldProcessRole(role) {
    if (role === "system") return false;
    if (ADVANCE_MODE === "assistant_only") return role === "assistant";
    if (ADVANCE_MODE === "user_only") return role === "user";
    return role === "assistant" || role === "user" || role === "unknown";
  }

function normalizeJudgeText(text) {
  return (text || "")
    .replace(/Thought for[^\n]*\n?/gi, "") // 去掉思考条
    .replace(/[ \t\r]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isPlaceholderText(text) {
  const t = normalizeJudgeText(text);
  if (!t) return true;
  if (/^(\.{2,}|…+|—+|[-~_]+)$/.test(t)) return true; // ... 之类
  if (/^(typing|正在输入|思考中|生成中)$/i.test(t)) return true;
  return false;
}

 function extractMessageText(mesEl) {
  const t =
    mesEl.querySelector(".mes_text")?.innerText ||
    mesEl.querySelector(".message_text")?.innerText ||
    mesEl.innerText ||
    "";
  return normalizeJudgeText(t);
}

  function queueMesForSettlement(mesEl) {
    if (!mesEl || processedMes.has(mesEl)) return;

    const role = getMesRole(mesEl);
    if (!shouldProcessRole(role)) return;

    const old = pendingStableCheck.get(mesEl);
    if (old?.timer) clearTimeout(old.timer);

    const rec = old || {
      startedAt: Date.now(),
      lastText: "",
      stableCount: 0,
      timer: null
    };

    rec.timer = setTimeout(() => stableTick(mesEl), STABLE_CHECK_INTERVAL);
    pendingStableCheck.set(mesEl, rec);
  }

 function stableTick(mesEl) {
  if (!mesEl || processedMes.has(mesEl)) return;

  const rec = pendingStableCheck.get(mesEl);
  if (!rec) return;

  const role = getMesRole(mesEl);
  const rawText = extractMessageText(mesEl);
  const text = normalizeJudgeText(rawText);
  const waited = Date.now() - rec.startedAt;

  const isAssistant = role === "assistant";
  const minWait = isAssistant ? ASSISTANT_MIN_SETTLE_WAIT : 0;
  const minLen = isAssistant ? ASSISTANT_MIN_CONTENT_LEN : 1;

  if (!text || isPlaceholderText(text)) {
    if (waited > STABLE_MAX_WAIT) {
      pendingStableCheck.delete(mesEl);
    } else {
      rec.timer = setTimeout(() => stableTick(mesEl), STABLE_CHECK_INTERVAL);
    }
    return;
  }

  // assistant 文本太短且等待时间不够：继续等，防止提早结算
  if (isAssistant && (text.length < minLen || waited < minWait)) {
    rec.lastText = text;
    rec.stableCount = 0;
    rec.timer = setTimeout(() => stableTick(mesEl), STABLE_CHECK_INTERVAL);
    return;
  }

  if (text === rec.lastText) rec.stableCount += 1;
  else {
    rec.lastText = text;
    rec.stableCount = 0;
  }

  const stableEnough = rec.stableCount >= STABLE_CONFIRM_COUNT && waited >= minWait;
  const timeout = waited > STABLE_MAX_WAIT;

  if (stableEnough || timeout) {
    // 超时时仍太短就放弃本次，避免+1噪声
    if (isAssistant && text.length < Math.max(6, minLen - 4)) {
      pendingStableCheck.delete(mesEl);
      return;
    }

    pendingStableCheck.delete(mesEl);
    processMesElement(mesEl);
    return;
  }

  rec.timer = setTimeout(() => stableTick(mesEl), STABLE_CHECK_INTERVAL);
}

  function processMesElement(mesEl) {
  if (!mesEl || processedMes.has(mesEl)) return;

  const role = getMesRole(mesEl);
  if (!shouldProcessRole(role)) return;

  const text = extractMessageText(mesEl);
  if (!text || isPlaceholderText(text)) return;

  // assistant过短文本（如“嗯”）默认不推动时间，避免机械+1
  if (role === "assistant" && text.length < 8) {
    processedMes.add(mesEl);
    return;
  }

  processedMes.add(mesEl);

  tryParseWeather(text);
  tryParseDate(text);

  if (tryParseAbsoluteTime(text)) return;
  if (tryParsePeriodAnchor(text)) return;

  const estimation = estimateMinutesByText(text);
  recordTransition(estimation.delta, estimation.reason, text);
  applyDelta(estimation.delta);
}

  // ---------- 设置 ----------
  function openSettings() {
    const menu = prompt(
`Story Time 设置
当前：${hhmm(state.minutes)} | ${state.month}月${state.day}日 | ${state.weather}
自动天气：${state.autoWeather ? "开" : "关"}
结算模式：${ADVANCE_MODE}
当前会话Key：${chatKey}

1 设置时间(HH:mm)
2 设置日期(M-D)
3 设置天气
4 切换自动天气
5 重置当前会话状态
6 查看注入状态

输入序号：`
    );
    if (!menu) return;
    const c = menu.trim();

    if (c === "1") {
      const t = prompt("输入时间（如 07:30）", hhmm(state.minutes));
      if (!t) return;
      const m = t.match(/^([01]?\d|2[0-3])[:：]([0-5]\d)$/);
      if (!m) return alert("时间格式错误");
      setAbsoluteTime(parseInt(m[1], 10), parseInt(m[2], 10), "manual", "手动设置时间");
      return;
    }

    if (c === "2") {
      const d = prompt("输入日期（如 2-14 或 2/14）", `${state.month}-${state.day}`);
      if (!d) return;
      const m = d.match(/^(\d{1,2})[-/](\d{1,2})$/);
      if (!m) return alert("日期格式错误");
      const mm = parseInt(m[1], 10);
      const dd = parseInt(m[2], 10);
      if (mm < 1 || mm > 12 || dd < 1 || dd > daysInMonth(state.year, mm)) return alert("日期不合法");
      state.month = mm;
      state.day = dd;
      commitState();
      return;
    }

    if (c === "3") {
      const w = prompt("输入天气：晴 / 多云 / 阴 / 小雨 / 中雨 / 雷阵雨 / 雪 / 雾", state.weather);
      if (!w) return;
      state.weather = w.trim();
      commitState();
      return;
    }

    if (c === "4") {
      state.autoWeather = !state.autoWeather;
      commitState();
      alert(`自动天气已${state.autoWeather ? "开启" : "关闭"}`);
      return;
    }

    if (c === "5") {
      if (!confirm("确定重置当前会话状态吗？")) return;
      state = { ...DEFAULT_STATE };
      commitState();
      return;
    }

    if (c === "6") {
      const injected = window.storyTimeDebug?.injected ? "成功" : "失败/未知";
      alert(`提示词注入状态：${injected}\n当前会话Key：${chatKey}`);
    }
  }

  // ---------- 观察器 ----------
  function bindChatObserver(chat) {
    if (chatObserver) {
      chatObserver.disconnect();
      chatObserver = null;
    }

    currentChatEl = chat;
    if (!chat) return;

    // 历史消息不重算
    chat.querySelectorAll(".mes").forEach((el) => processedMes.add(el));

    chatObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "childList") {
          for (const node of m.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;

            if (node.classList?.contains("mes")) {
              queueMesForSettlement(node);
            }

            node.querySelectorAll?.(".mes").forEach((el) => queueMesForSettlement(el));
          }
        }

        if (m.type === "characterData") {
          const p = m.target?.parentElement;
          const mes = p?.closest?.(".mes");
          if (mes) queueMesForSettlement(mes);
        }

        if (m.type === "attributes") {
          const t = m.target instanceof HTMLElement ? m.target : m.target?.parentElement;
          const mes = t?.closest?.(".mes");
          if (mes) queueMesForSettlement(mes);
        }
      }
    });

    chatObserver.observe(chat, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true
    });
  }

  function ensureChatBinding() {
    const chat = document.querySelector("#chat");
    if (chat !== currentChatEl) bindChatObserver(chat);
    ensureBar();
  }

  // ---------- 启动 ----------
  function boot() {
    chatKey = getChatKey();
    loadState();
    ensureChatBinding();
    commitState();

    setInterval(() => {
      ensureChatBinding();

      const k = getChatKey();
      if (k !== chatKey) {
        chatKey = k;
        loadState();
        commitState();
      }
    }, 800);

    console.log("[Story Time v0.28] loaded.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();