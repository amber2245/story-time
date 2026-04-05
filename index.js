(() => {
  "use strict";

  const EXT_ID = "story_time";
  const MAX_RECENT_TURNS = 8;

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
  let recentTurns = [];

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

    for (const v of candidates) {
      if (v !== undefined && v !== null && String(v).trim() !== "") {
        return `${EXT_ID}:${String(v)}`;
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
    if (days > 0) for (let i = 0; i < days; i++) advanceOneDay();
    if (days < 0) for (let i = 0; i < Math.abs(days); i++) backOneDay();
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
    if (delta >= 300 || reason === "sleep" || reason === "sleep_chain") {
      if (phase === "清晨") return "第二天清晨";
      if (phase === "上午") return "第二天早上";
      if (phase === "中午") return "第二天中午";
      if (phase === "下午") return "第二天下午";
      if (phase === "傍晚") return "第二天傍晚";
      return `第二天${phase}`;
    }
    if (delta >= 120) return `数小时后，已是${phase}`;
    if (delta >= 30) return `${phase}稍晚些时候`;
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

  function pushRecentTurn(text, delta, reason) {
    const clean = (text || "").replace(/\s+/g, " ").trim();
    if (!clean) return;
    recentTurns.push({
      text: clean.slice(0, 220),
      delta: Number(delta) || 0,
      reason: reason || "",
      at: Date.now()
    });
    if (recentTurns.length > MAX_RECENT_TURNS) recentTurns.shift();
  }

  function testReg(reg, text) {
    if (!reg) return false;
    reg.lastIndex = 0;
    return reg.test(text);
  }

  function hasRecent(reg, limit = 4) {
    let checked = 0;
    for (let i = recentTurns.length - 1; i >= 0 && checked < limit; i--, checked++) {
      if (testReg(reg, recentTurns[i].text)) return true;
    }
    return false;
  }

  function recentSummary(limit = 4) {
    return recentTurns.slice(-limit).map((x) => x.text).join(" | ");
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
      if (act === "+10") applyDelta(10, "manual", "手动调整+10m");
      if (act === "-10") applyDelta(-10, "manual", "手动调整-10m");
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

  // ---------- 注入 ----------
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
      console.warn("[Story Time] extensionPrompts write failed:", err);
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
    const recentJump = state.lastDeltaMinutes >= 30;
    const weatherImportant = /小雨|中雨|雷阵雨|雪|雾/.test(state.weather);

    const dynamicRules = [];
    if (recentJump) dynamicRules.push("最近发生了明显时间推进，请在合适位置自然体现时段变化。");
    else dynamicRules.push("最近没有明显时间跳跃，不要刻意重复时段词。");

    if (state.lastDeltaMinutes >= 120 || state.lastDeltaReason === "sleep" || state.lastDeltaReason === "sleep_chain") {
      dynamicRules.push("若刚经历睡眠/数小时跳时，可自然使用“第二天清晨”“数小时后”等表达。");
    }

    if (weatherImportant) dynamicRules.push("当前天气会影响体感和行动，可在需要时体现。");
    else dynamicRules.push("天气默认作为背景，不必每轮都提。");

    if (festival) dynamicRules.push("节日仅在互动确实相关时再体现，不要每轮复读。");

    return `[剧情状态]
- 当前时间: ${hhmm(state.minutes)}（${getPhase(state.minutes)}）
- 当前日期: ${state.month}月${state.day}日
- 当前天气: ${state.weather}
- 当前节日: ${festival || "无"}
- 时段倾向: ${getMealHint(state.minutes)}
- 最近时间变化: ${formatDelta(state.lastDeltaMinutes)}
- 最近变化原因: ${state.lastDeltaReason || "无"}
- 建议表现: ${state.lastTransitionLabel || "无需特别强调"}

[写作原则]
1. 始终遵守剧情状态，让行为、作息、环境与时间天气一致。
2. 不要每条都重复“早晨/下雨/节日”；只在它们影响当前场景与行为时自然体现。
3. 若上一条已表现过时段或天气，本条应收敛，除非剧情有新变化。
4. 除非剧情明确再次跳时，否则不要擅自大幅改动时间。

[本轮额外提醒]
- ${dynamicRules.join("\n- ")}`;
  }

  function refreshModelState() {
    const prompt = buildPrompt();
    const ctx = getContextSafe();
    const ok = setExtensionPrompt(prompt);

    window.storyTimeDebug = {
      chatKey,
      state: { ...state },
      prompt,
      injected: ok,
      extensionPromptEntry: ctx?.extensionPrompts?.[EXT_ID] || null,
      recentTurns: [...recentTurns]
    };
  }

  // ---------- 时间推进 ----------
  function applyDelta(delta, reason = "generic_progress", triggerText = "") {
    if (!delta || Number.isNaN(delta)) return;
    recordTransition(delta, reason, triggerText);
    state.minutes += delta;
    normalizeTime();
    pushRecentTurn(triggerText || reason, delta, reason);
    commitState();
  }

  function setAbsoluteTime(h, m, reason = "absolute_time", text = "") {
    const oldMinutes = state.minutes;
    state.minutes = h * 60 + m;
    normalizeTime();
    const delta = state.minutes - oldMinutes;
    recordTransition(delta, reason, text);
    pushRecentTurn(text || `绝对时间设定 ${hhmm(state.minutes)}`, delta, reason);
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

  // Layer 1: 绝对锚点
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
    let deltaGuess = 0;

    if (/(第二天|次日|翌日|隔天)/.test(text)) {
      shiftDate(1);
      touched = true;
      deltaGuess += 1440;
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
      if (deltaGuess === 0) deltaGuess = 60;
    }

    if (!touched) return false;

    normalizeTime();
    recordTransition(deltaGuess, "period_anchor", text);
    pushRecentTurn(text, deltaGuess, "period_anchor");
    commitState();
    return true;
  }

  // Layer 2: 显式时长
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

  // Layer 3: 事件类别
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
      if (!testReg(rule.reg, text)) continue;
      count += 1;
      let [min, max] = rule.range;

      if (rule.name === "meal") {
        const current = state.minutes;
        if (current >= 330 && current <= 570) [min, max] = [15, 30];
        else if (current >= 660 && current <= 870) [min, max] = [25, 45];
        else if (current >= 1020 && current <= 1260) [min, max] = [30, 55];
      }

      minutes += pickRange(min, max, `${text}|${rule.name}|${state.minutes}`);
      if (!mainReason) mainReason = rule.reason;
    }

    return { minutes, count, reason: mainReason };
  }

  // Layer 4: 叙事流逝
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

  // Layer 4.5: 上下文链加权（v0.28重点）
  function estimateContextBonus(text) {
    let bonus = 0;
    let forcedMin = 0;
    let reason = "";

    const leaveRe = /(准备出门|出门了|出发|动身|前往|赶去|上路)/;
    const arriveRe = /(到了|到达|抵达|来到|进了|赶到|回到)/;
    const mealPrepRe = /(做饭|下厨|点餐|准备吃|去吃|开饭|用餐前)/;
    const mealDoneRe = /(吃完|吃过|饭后|用餐结束|用过餐)/;
    const tiredRe = /(困|疲惫|倦意|打哈欠|眼皮打架|想睡|闭上眼|躺下)/;
    const sleepRe = /(睡着|入睡|睡过去|昏睡|睡了过去)/;
    const workStartRe = /(开始工作|开始学习|投入工作|上课了|忙起来)/;
    const workEndRe = /(下班|下课|做完了|忙完了|告一段落|终于结束)/;

    if (testReg(arriveRe, text) && hasRecent(leaveRe, 4)) {
      bonus += pickRange(12, 40, text + "|travel_chain");
      reason = reason || "travel_chain";
    }

    if (testReg(mealDoneRe, text) && hasRecent(mealPrepRe, 4)) {
      bonus += pickRange(10, 25, text + "|meal_chain");
      reason = reason || "meal_chain";
    }

    if (testReg(workEndRe, text) && hasRecent(workStartRe, 5)) {
      bonus += pickRange(45, 140, text + "|work_cycle");
      reason = reason || "work_cycle";
    }

    if (testReg(sleepRe, text) && hasRecent(tiredRe, 4)) {
      forcedMin = Math.max(forcedMin, pickRange(300, 420, text + "|sleep_chain"));
      reason = reason || "sleep_chain";
    }

    if (/已经.*(吃完|做完|换好|收拾好|处理完|结束了)/.test(text)) {
      bonus += pickRange(6, 20, text + "|result_clause");
      reason = reason || "result_clause";
    }

    if (/(回过神来|再看时|不知何时|不知不觉已经)/.test(text)) {
      bonus += pickRange(8, 24, text + "|implicit_elapsed");
      reason = reason || "implicit_elapsed";
    }

    return { bonus, forcedMin, reason };
  }

  // Layer 5: 兜底
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
    if (!text) return { delta: 0, reason: "none" };

    const explicit = parseExplicitDuration(text);
    const category = estimateCategoryMinutes(text);
    const narrative = estimateNarrativeMinutes(text);
    const contextBonus = estimateContextBonus(text);

    let total = 0;
    let reason = "";

    if (explicit.hit) {
      total = explicit.minutes + Math.round((category.minutes + narrative.minutes) * 0.35);
      total += Math.round(contextBonus.bonus * 0.35);
      reason = "explicit_duration";
    } else {
      total = category.minutes + narrative.minutes + contextBonus.bonus;
      reason = category.reason || narrative.reason || contextBonus.reason || "";
      if (category.count >= 2 && total > 0) {
        const factor = 1 + Math.min(0.35, (category.count - 1) * 0.1);
        total = Math.round(total * factor);
      }
    }

    if (contextBonus.forcedMin > 0) {
      total = Math.max(total, contextBonus.forcedMin);
      if (!reason) reason = contextBonus.reason || "context_chain";
    }

    // 如果上一条刚大跳时，这一条又没有明显事件，自动收敛，防“连续暴跳”
    const last = recentTurns[recentTurns.length - 1];
    if (
      last &&
      last.delta >= 180 &&
      !explicit.hit &&
      category.count === 0 &&
      narrative.minutes === 0 &&
      contextBonus.bonus === 0 &&
      text.replace(/\s+/g, "").length < 20
    ) {
      total = Math.max(1, Math.round(total * 0.5));
      reason = reason || "post_jump_cooldown";
    }

    if (total <= 0) {
      total = estimateFallbackMinutes(text);
      reason = "fallback_chat";
    }

    return {
      delta: Math.min(total, 360), // 单条最多6小时
      reason: reason || "generic_progress"
    };
  }

  // ---------- 日期天气 ----------
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

  // ---------- 消息 ----------
  function extractMessageText(mesEl) {
    const t =
      mesEl.querySelector(".mes_text")?.innerText ||
      mesEl.querySelector(".message_text")?.innerText ||
      mesEl.innerText ||
      "";
    return t.trim();
  }

  function processMesElement(mesEl) {
    if (!mesEl || processedMes.has(mesEl)) return;

    const text = extractMessageText(mesEl);
    if (!text) return;
    processedMes.add(mesEl);

    tryParseWeather(text);
    tryParseDate(text);

    if (tryParseAbsoluteTime(text)) return;
    if (tryParsePeriodAnchor(text)) return;

    const result = estimateMinutesByText(text);
    applyDelta(result.delta, result.reason, text);
  }

  // ---------- 设置 ----------
  function openSettings() {
    const menu = prompt(
`Story Time v0.28 设置
当前：${hhmm(state.minutes)} | ${state.month}月${state.day}日 | ${state.weather}
自动天气：${state.autoWeather ? "开" : "关"}
会话Key：${chatKey}

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
      recentTurns = [];
      commitState();
      return;
    }

    if (c === "6") {
      const injected = window.storyTimeDebug?.injected ? "成功" : "失败/未知";
      alert(`提示词注入状态：${injected}\n会话Key：${chatKey}`);
    }
  }

  // ---------- 观察 ----------
  function bindChatObserver(chat) {
    if (chatObserver) {
      chatObserver.disconnect();
      chatObserver = null;
    }

    currentChatEl = chat;
    if (!chat) return;

    chat.querySelectorAll(".mes").forEach((el) => processedMes.add(el));

    chatObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;

          if (node.classList?.contains("mes")) {
            setTimeout(() => processMesElement(node), 350);
            setTimeout(() => processMesElement(node), 1200);
          }

          node.querySelectorAll?.(".mes").forEach((el) => {
            setTimeout(() => processMesElement(el), 350);
            setTimeout(() => processMesElement(el), 1200);
          });
        }
      }
    });

    chatObserver.observe(chat, { childList: true, subtree: true });
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
    recentTurns = [];
    ensureChatBinding();
    commitState();

    setInterval(() => {
      ensureChatBinding();

      const k = getChatKey();
      if (k !== chatKey) {
        chatKey = k;
        loadState();
        recentTurns = [];
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