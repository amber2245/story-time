(() => {
  "use strict";

  // ===============================
  // Story Time v0.29
  // - 只按 char 消息推进
  // - 等消息稳定后再推进
  // - 删除/重说自动回滚重算
  // - 会话独立记忆
  // - 时间流速倍率按钮
  // ===============================

  const EXT_ID = "story_time";
  const SETTLE_MS = 1400; // 消息文本稳定多久后视为“生成完成”
  const MAX_RECENT_TURNS = 8;
  const RATE_OPTIONS = [0.5, 1, 1.5, 2, 3];

  const FESTIVALS = {
    "1-1": "元旦",
    "2-14": "情人节",
    "6-1": "儿童节",
    "10-1": "国庆节",
    "10-31": "万圣节",
    "12-25": "圣诞节",
    "12-31": "跨年夜"
  };

  const DEFAULT_ANCHOR = {
    year: 1,
    month: 1,
    day: 1,
    minutes: 7 * 60 + 30,
    weather: "晴"
  };

  const DEFAULT_STATE = {
    // 锚点（手动设置/微调基准，重算从这里出发）
    anchor: { ...DEFAULT_ANCHOR },

    // 设置
    autoWeather: true,
    timeRate: 1,

    // 派生结果（根据当前会话已稳定的char消息重算得到）
    year: DEFAULT_ANCHOR.year,
    month: DEFAULT_ANCHOR.month,
    day: DEFAULT_ANCHOR.day,
    minutes: DEFAULT_ANCHOR.minutes,
    weather: DEFAULT_ANCHOR.weather,

    // 最近一次推进信息（用于提示注入）
    lastDeltaMinutes: 0,
    lastDeltaReason: "",
    lastTriggerText: "",
    lastTransitionLabel: ""
  };

  let state = structuredCloneSafe(DEFAULT_STATE);
  let chatKey = "";
  let barEl = null;
  let currentChatEl = null;
  let chatObserver = null;

  // 用于跟踪每条消息内容是否稳定
  let messageTrack = new Map(); // msgId -> { hash, changedAt }
  let msgSeq = 1;
  let recomputeTimer = null;

  // 防重复
  let lastRenderedSnapshot = "";

  // ---------- Utils ----------
  function structuredCloneSafe(obj) {
    try {
      return structuredClone(obj);
    } catch (_) {
      return JSON.parse(JSON.stringify(obj));
    }
  }

  function hashText(text) {
    let h = 0;
    const s = String(text || "");
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
  }

  function pickRange(min, max, seed = "") {
    if (max <= min) return min;
    return min + (hashText(seed) % (max - min + 1));
  }

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function hhmm(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  function formatRate(v) {
    return `x${Number(v).toFixed(v % 1 === 0 ? 0 : 1)}`;
  }

  function formatDelta(minutes) {
    if (!minutes) return "无";
    const sign = minutes >= 0 ? "+" : "-";
    const abs = Math.abs(minutes);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    if (h && m) return `${sign}${h}小时${m}分钟`;
    if (h) return `${sign}${h}小时`;
    return `${sign}${m}分钟`;
  }

  function testReg(reg, text) {
    reg.lastIndex = 0;
    return reg.test(text);
  }

  // ---------- Context ----------
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

  // ---------- State Load/Save ----------
  function migrateState(raw) {
    const base = structuredCloneSafe(DEFAULT_STATE);

    // 兼容旧版（顶层 year/month/day/minutes/weather）
    if (!raw.anchor) {
      raw.anchor = {
        year: Number.isFinite(raw.year) ? raw.year : base.anchor.year,
        month: Number.isFinite(raw.month) ? raw.month : base.anchor.month,
        day: Number.isFinite(raw.day) ? raw.day : base.anchor.day,
        minutes: Number.isFinite(raw.minutes) ? raw.minutes : base.anchor.minutes,
        weather: raw.weather || base.anchor.weather
      };
    }

    const merged = {
      ...base,
      ...raw,
      anchor: {
        ...base.anchor,
        ...(raw.anchor || {})
      }
    };

    if (!Number.isFinite(merged.timeRate)) merged.timeRate = 1;
    merged.timeRate = clamp(merged.timeRate, 0.5, 3);

    normalizeClock(merged.anchor, merged.autoWeather);
    return merged;
  }

  function loadState() {
    const raw = localStorage.getItem(chatKey);
    if (!raw) {
      state = structuredCloneSafe(DEFAULT_STATE);
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      state = migrateState(parsed);
    } catch (_) {
      state = structuredCloneSafe(DEFAULT_STATE);
    }
  }

  function saveState() {
    localStorage.setItem(chatKey, JSON.stringify(state));
  }

  // ---------- Calendar / Weather ----------
  function daysInMonth(year, month) {
    if (month === 2) return 28;
    if ([4, 6, 9, 11].includes(month)) return 30;
    return 31;
  }

  function weatherPoolByMonth(month) {
    if ([3, 4, 5].includes(month)) return ["晴", "晴", "多云", "阴", "小雨", "雾"];
    if ([6, 7, 8].includes(month)) return ["晴", "多云", "阴", "小雨", "中雨", "雷阵雨"];
    if ([9, 10, 11].includes(month)) return ["晴", "晴", "多云", "阴", "小雨", "雾"];
    return ["晴", "多云", "阴", "小雨", "雪", "雾"];
  }

  // 用日期+会话key做确定性天气（重算时不飘）
  function deterministicWeather(year, month, day) {
    const pool = weatherPoolByMonth(month);
    const seed = hashText(`${chatKey}|${year}-${month}-${day}`);
    return pool[seed % pool.length];
  }

  function advanceOneDay(clock, autoWeather) {
    clock.day += 1;
    if (clock.day > daysInMonth(clock.year, clock.month)) {
      clock.day = 1;
      clock.month += 1;
      if (clock.month > 12) {
        clock.month = 1;
        clock.year += 1;
      }
    }
    if (autoWeather) clock.weather = deterministicWeather(clock.year, clock.month, clock.day);
  }

  function backOneDay(clock, autoWeather) {
    if (clock.year === 1 && clock.month === 1 && clock.day === 1) return;
    clock.day -= 1;
    if (clock.day < 1) {
      clock.month -= 1;
      if (clock.month < 1) {
        clock.month = 12;
        clock.year = Math.max(1, clock.year - 1);
      }
      clock.day = daysInMonth(clock.year, clock.month);
    }
    if (autoWeather) clock.weather = deterministicWeather(clock.year, clock.month, clock.day);
  }

  function shiftDate(clock, days, autoWeather) {
    if (days > 0) for (let i = 0; i < days; i++) advanceOneDay(clock, autoWeather);
    if (days < 0) for (let i = 0; i < Math.abs(days); i++) backOneDay(clock, autoWeather);
  }

  function normalizeClock(clock, autoWeather) {
    let dayShift = 0;
    while (clock.minutes >= 1440) {
      clock.minutes -= 1440;
      dayShift += 1;
    }
    while (clock.minutes < 0) {
      clock.minutes += 1440;
      dayShift -= 1;
    }
    if (dayShift !== 0) shiftDate(clock, dayShift, autoWeather);
  }

  function getFestival(month, day) {
    return FESTIVALS[`${month}-${day}`] || "";
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

  function buildTransitionLabel(delta, reason, currentMinutes) {
    const phase = getPhase(currentMinutes);

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

  // ---------- Message helpers ----------
  function ensureMsgId(mesEl) {
    if (!mesEl.dataset.storyTimeMsgId) {
      mesEl.dataset.storyTimeMsgId = `stm_${Date.now()}_${msgSeq++}`;
    }
    return mesEl.dataset.storyTimeMsgId;
  }

  function extractMessageText(mesEl) {
    const t =
      mesEl.querySelector(".mes_text")?.innerText ||
      mesEl.querySelector(".message_text")?.innerText ||
      mesEl.innerText ||
      "";
    return String(t || "").trim();
  }

  function isUserMessage(mesEl) {
    if (!mesEl) return false;

    if (
      mesEl.classList.contains("user_mes") ||
      mesEl.classList.contains("is_user") ||
      mesEl.getAttribute("is_user") === "true" ||
      mesEl.dataset.isUser === "true"
    ) {
      return true;
    }

    // 兜底：通过名字判断
    const ctx = getContextSafe();
    const name = mesEl.querySelector(".name_text")?.textContent?.trim();
    if (name && ctx?.name1 && name === ctx.name1) return true;

    return false;
  }

  function isSystemMessage(mesEl) {
    if (!mesEl) return false;
    if (
      mesEl.classList.contains("system_message") ||
      mesEl.classList.contains("mes_system") ||
      mesEl.getAttribute("is_system") === "true" ||
      mesEl.dataset.isSystem === "true"
    ) {
      return true;
    }
    return false;
  }

  function isAssistantMessage(mesEl) {
    return !isUserMessage(mesEl) && !isSystemMessage(mesEl);
  }

  // ---------- Parse helpers ----------
  function parseCNNumber(str) {
    if (!str) return NaN;
    if (/^\d+$/.test(str)) return parseInt(str, 10);
    if (str === "半") return 0.5;
    const map = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (map[str] != null) return map[str];
    if (str === "十") return 10;
    if (str.includes("十")) {
      const [a, b] = str.split("十");
      const tens = a ? (map[a] || 0) : 1;
      const ones = b ? (map[b] || 0) : 0;
      return tens * 10 + ones;
    }
    return NaN;
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

    return { hit, minutes };
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

  function estimateCategoryMinutes(text, currentMinutes) {
    let minutes = 0;
    let count = 0;
    let mainReason = "";

    for (const rule of CATEGORY_RULES) {
      if (!testReg(rule.reg, text)) continue;
      count += 1;
      let [min, max] = rule.range;

      if (rule.name === "meal") {
        if (currentMinutes >= 330 && currentMinutes <= 570) [min, max] = [15, 30];
        else if (currentMinutes >= 660 && currentMinutes <= 870) [min, max] = [25, 45];
        else if (currentMinutes >= 1020 && currentMinutes <= 1260) [min, max] = [30, 55];
      }

      minutes += pickRange(min, max, `${text}|${rule.name}|${currentMinutes}`);
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

  function recentHas(recent, reg, limit = 4) {
    let checked = 0;
    for (let i = recent.length - 1; i >= 0 && checked < limit; i--, checked++) {
      if (testReg(reg, recent[i].text)) return true;
    }
    return false;
  }

  function estimateContextBonus(text, recent) {
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

    if (testReg(arriveRe, text) && recentHas(recent, leaveRe, 4)) {
      bonus += pickRange(12, 40, text + "|travel_chain");
      reason = reason || "travel_chain";
    }

    if (testReg(mealDoneRe, text) && recentHas(recent, mealPrepRe, 4)) {
      bonus += pickRange(10, 25, text + "|meal_chain");
      reason = reason || "meal_chain";
    }

    if (testReg(workEndRe, text) && recentHas(recent, workStartRe, 5)) {
      bonus += pickRange(45, 140, text + "|work_cycle");
      reason = reason || "work_cycle";
    }

    if (testReg(sleepRe, text) && recentHas(recent, tiredRe, 4)) {
      forcedMin = Math.max(forcedMin, pickRange(300, 420, text + "|sleep_chain"));
      reason = reason || "sleep_chain";
    }

    if (/(已经.*(吃完|做完|换好|收拾好|处理完|结束了))/.test(text)) {
      bonus += pickRange(6, 20, text + "|result_clause");
      reason = reason || "result_clause";
    }

    if (/(回过神来|再看时|不知何时|不知不觉已经)/.test(text)) {
      bonus += pickRange(8, 24, text + "|implicit_elapsed");
      reason = reason || "implicit_elapsed";
    }

    return { bonus, forcedMin, reason };
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

  function estimateMinutesByText(text, currentMinutes, recent) {
    if (!text) return { delta: 0, reason: "none", scalable: true };

    const explicit = parseExplicitDuration(text);
    const category = estimateCategoryMinutes(text, currentMinutes);
    const narrative = estimateNarrativeMinutes(text);
    const ctxBonus = estimateContextBonus(text, recent);

    let total = 0;
    let reason = "";
    let scalable = true;

    if (explicit.hit) {
      // 明确时长：不参与倍率缩放（尊重剧情明确数字）
      total = explicit.minutes + Math.round((category.minutes + narrative.minutes) * 0.35) + Math.round(ctxBonus.bonus * 0.35);
      reason = "explicit_duration";
      scalable = false;
    } else {
      total = category.minutes + narrative.minutes + ctxBonus.bonus;
      reason = category.reason || narrative.reason || ctxBonus.reason || "";
      if (category.count >= 2 && total > 0) {
        const factor = 1 + Math.min(0.35, (category.count - 1) * 0.1);
        total = Math.round(total * factor);
      }
    }

    if (ctxBonus.forcedMin > 0) {
      total = Math.max(total, ctxBonus.forcedMin);
      reason = reason || ctxBonus.reason || "context_chain";
    }

    if (total <= 0) {
      total = estimateFallbackMinutes(text);
      reason = "fallback_chat";
    }

    return {
      delta: Math.min(total, 360),
      reason: reason || "generic_progress",
      scalable
    };
  }

  // ---------- Text => clock ----------
  function tryParseWeatherTo(clock, text) {
    let next = "";
    if (/雷阵雨|打雷/.test(text)) next = "雷阵雨";
    else if (/暴雨|大雨/.test(text)) next = "中雨";
    else if (/小雨|下雨|雨天/.test(text)) next = "小雨";
    else if (/下雪|雪天/.test(text)) next = "雪";
    else if (/多云/.test(text)) next = "多云";
    else if (/阴天|天阴/.test(text)) next = "阴";
    else if (/大雾|起雾|雾天/.test(text)) next = "雾";
    else if (/晴天|天晴|阳光明媚/.test(text)) next = "晴";

    if (next) clock.weather = next;
  }

  function tryParseDateTo(clock, text) {
    const m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
    if (!m) return false;
    const mm = parseInt(m[1], 10);
    const dd = parseInt(m[2], 10);
    if (mm < 1 || mm > 12) return false;
    if (dd < 1 || dd > daysInMonth(clock.year, mm)) return false;
    clock.month = mm;
    clock.day = dd;
    return true;
  }

  function tryParseAbsoluteTimeTo(clock, text) {
    let m = text.match(/([01]?\d|2[0-3])[:：]([0-5]\d)/);
    if (m) {
      clock.minutes = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
      return true;
    }

    m = text.match(/([01]?\d|2[0-3])\s*点\s*([0-5]?\d)?\s*分?/);
    if (m) {
      clock.minutes = parseInt(m[1], 10) * 60 + (m[2] ? parseInt(m[2], 10) : 0);
      return true;
    }

    return false;
  }

  function tryParsePeriodAnchorTo(clock, text, autoWeather) {
    let touched = false;
    let approxDelta = 0;

    if (/(第二天|次日|翌日|隔天)/.test(text)) {
      shiftDate(clock, 1, autoWeather);
      touched = true;
      approxDelta += 1440;
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
      clock.minutes = map[period] ?? clock.minutes;
      touched = true;
      if (approxDelta === 0) approxDelta = 60;
    }

    if (!touched) return { hit: false, delta: 0 };
    normalizeClock(clock, autoWeather);
    return { hit: true, delta: approxDelta };
  }

  function applyTextToClock(clock, text, recent, opts) {
    const autoWeather = Boolean(opts.autoWeather);
    const timeRate = Number(opts.timeRate) || 1;

    const beforeMinutes = clock.minutes;

    // 天气/日期可并行解析
    tryParseWeatherTo(clock, text);
    tryParseDateTo(clock, text);

    // 绝对时间优先
    if (tryParseAbsoluteTimeTo(clock, text)) {
      normalizeClock(clock, autoWeather);
      return {
        applied: true,
        delta: clock.minutes - beforeMinutes,
        reason: "absolute_time",
        text
      };
    }

    // 时段锚点
    const anchor = tryParsePeriodAnchorTo(clock, text, autoWeather);
    if (anchor.hit) {
      return {
        applied: true,
        delta: anchor.delta,
        reason: "period_anchor",
        text
      };
    }

    // 普通推断
    const est = estimateMinutesByText(text, clock.minutes, recent);
    let delta = est.delta;

    if (est.scalable) {
      delta = Math.max(1, Math.round(delta * timeRate));
    }

    clock.minutes += delta;
    normalizeClock(clock, autoWeather);

    return {
      applied: true,
      delta,
      reason: est.reason,
      text
    };
  }

  // ---------- Recompute Core ----------
  function simulateFromAssistantMessages(messages) {
    const sim = {
      year: state.anchor.year,
      month: state.anchor.month,
      day: state.anchor.day,
      minutes: state.anchor.minutes,
      weather: state.anchor.weather
    };

    normalizeClock(sim, state.autoWeather);

    const recent = [];
    let lastDelta = 0;
    let lastReason = "";
    let lastText = "";

    for (const msg of messages) {
      const step = applyTextToClock(sim, msg.text, recent, {
        autoWeather: state.autoWeather,
        timeRate: state.timeRate
      });

      if (step.applied) {
        lastDelta = step.delta;
        lastReason = step.reason;
        lastText = step.text;
      }

      recent.push({
        text: msg.text,
        delta: step.delta || 0,
        reason: step.reason || ""
      });
      if (recent.length > MAX_RECENT_TURNS) recent.shift();
    }

    const lastTransitionLabel = buildTransitionLabel(lastDelta, lastReason, sim.minutes);

    return {
      sim,
      lastDelta,
      lastReason,
      lastText,
      lastTransitionLabel,
      recent
    };
  }

  function snapshotState() {
    return JSON.stringify({
      y: state.year,
      mo: state.month,
      d: state.day,
      m: state.minutes,
      w: state.weather,
      ld: state.lastDeltaMinutes,
      lr: state.lastDeltaReason,
      rt: state.timeRate
    });
  }

  function recomputeTimeline() {
    recomputeTimer = null;

    const chat = document.querySelector("#chat");
    if (!chat) return;

    const now = Date.now();
    const mesList = Array.from(chat.querySelectorAll(".mes"));
    const aliveIds = new Set();

    const settledAssistantMessages = [];
    let hasUnsettledAssistant = false;

    for (const mesEl of mesList) {
      const id = ensureMsgId(mesEl);
      aliveIds.add(id);

      const text = extractMessageText(mesEl);
      if (!text) continue;

      const h = hashText(text);
      const rec = messageTrack.get(id);

      if (!rec) {
        messageTrack.set(id, { hash: h, changedAt: now });
      } else if (rec.hash !== h) {
        rec.hash = h;
        rec.changedAt = now;
      }

      if (!isAssistantMessage(mesEl)) continue;

      const changedAt = messageTrack.get(id)?.changedAt ?? now;
      const settled = now - changedAt >= SETTLE_MS;

      if (!settled) {
        hasUnsettledAssistant = true;
        continue;
      }

      settledAssistantMessages.push({ id, text });
    }

    // 清理已不存在消息
    for (const id of messageTrack.keys()) {
      if (!aliveIds.has(id)) messageTrack.delete(id);
    }

    // 基于“已稳定的char消息”重算
    const result = simulateFromAssistantMessages(settledAssistantMessages);

    state.year = result.sim.year;
    state.month = result.sim.month;
    state.day = result.sim.day;
    state.minutes = result.sim.minutes;
    state.weather = result.sim.weather;

    state.lastDeltaMinutes = result.lastDelta || 0;
    state.lastDeltaReason = result.lastReason || "";
    state.lastTriggerText = (result.lastText || "").slice(0, 120);
    state.lastTransitionLabel = result.lastTransitionLabel || "";

    const snap = snapshotState();
    if (snap !== lastRenderedSnapshot) {
      lastRenderedSnapshot = snap;
      saveState();
      renderBar();
      refreshModelState(result.recent);
    }

    // 还有未稳定的 assistant 消息，继续等
    if (hasUnsettledAssistant) {
      scheduleRecompute(Math.max(400, Math.floor(SETTLE_MS * 0.5)));
    }
  }

  function scheduleRecompute(delay = 280) {
    if (recomputeTimer) clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(recomputeTimeline, delay);
  }

  // ---------- Prompt Injection ----------
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
    } catch (_) {}

    try {
      if (typeof ctx.setExtensionPrompt === "function") {
        ctx.setExtensionPrompt(EXT_ID, prompt, 0, 1);
        ok = true;
      }
    } catch (_) {}

    return ok;
  }

  function buildPrompt(recent = []) {
    const festival = getFestival(state.month, state.day);
    const recentJump = state.lastDeltaMinutes >= 30;
    const weatherImportant = /小雨|中雨|雷阵雨|雪|雾/.test(state.weather);

    const rules = [];

    if (recentJump) rules.push("最近发生了明显时间推进，请自然体现时段变化。");
    else rules.push("最近没有明显跳时，不要刻意重复时段词。");

    if (state.lastDeltaMinutes >= 120 || state.lastDeltaReason === "sleep" || state.lastDeltaReason === "sleep_chain") {
      rules.push("若刚经历睡眠/数小时推进，可自然使用“第二天清晨”“数小时后”等表达。");
    }

    if (weatherImportant) rules.push("当前天气会影响环境与行动，可在需要时体现。");
    else rules.push("天气默认作为背景信息，不必每条都提。");

    if (festival) rules.push("节日仅在互动确实相关时再体现，不要机械复读。");

    return `[剧情状态]
- 当前时间: ${hhmm(state.minutes)}（${getPhase(state.minutes)}）
- 当前日期: ${state.month}月${state.day}日
- 当前天气: ${state.weather}
- 当前节日: ${festival || "无"}
- 当前时段倾向: ${getMealHint(state.minutes)}
- 最近时间变化: ${formatDelta(state.lastDeltaMinutes)}
- 最近变化原因: ${state.lastDeltaReason || "无"}
- 建议表现: ${state.lastTransitionLabel || "无需特别强调"}
- 时间流速倍率: ${formatRate(state.timeRate)}

[写作原则]
1) 你的描写与行为必须符合当前时间/天气/日期。
2) 不要每条都重复“早晨/节日/天气”，只在剧情需要时自然体现。
3) 若上一条已强调时段，本条除非出现新变化，否则应收敛。
4) 除非剧情明确再次跳时，否则不要擅自大幅改动时间。

[本轮提醒]
- ${rules.join("\n- ")}`;
  }

  function refreshModelState(recent = []) {
    const prompt = buildPrompt(recent);
    const ctx = getContextSafe();
    const ok = setExtensionPrompt(prompt);

    window.storyTimeDebug = {
      chatKey,
      injected: ok,
      state: structuredCloneSafe(state),
      prompt,
      extensionPromptEntry: ctx?.extensionPrompts?.[EXT_ID] || null,
      recentPreview: recent.slice(-4)
    };
  }

  // ---------- UI ----------
  function renderBar() {
    if (!barEl) return;

    const timeEl = barEl.querySelector("#st-story-clock-time");
    const metaEl = barEl.querySelector("#st-story-clock-meta");
    const rateEl = barEl.querySelector('[data-act="rate"]');

    if (timeEl) timeEl.textContent = hhmm(state.minutes);

    const festival = getFestival(state.month, state.day);
    const meta = `${state.month}月${state.day}日 · ${state.weather}${festival ? ` · ${festival}` : ""}`;
    if (metaEl) metaEl.textContent = meta;

    if (rateEl) rateEl.textContent = formatRate(state.timeRate);
  }

  function nextRate(current) {
    const idx = RATE_OPTIONS.findIndex((x) => Math.abs(x - current) < 0.001);
    if (idx < 0) return 1;
    return RATE_OPTIONS[(idx + 1) % RATE_OPTIONS.length];
  }

  function adjustAnchorByMinutes(delta) {
    state.anchor.minutes += delta;
    normalizeClock(state.anchor, state.autoWeather);
    saveState();
    scheduleRecompute(10);
  }

  function setAnchorTime(h, m) {
    state.anchor.minutes = h * 60 + m;
    normalizeClock(state.anchor, state.autoWeather);
    saveState();
    scheduleRecompute(10);
  }

  function setAnchorDate(mm, dd) {
    state.anchor.month = mm;
    state.anchor.day = dd;
    normalizeClock(state.anchor, state.autoWeather);
    saveState();
    scheduleRecompute(10);
  }

  function setAnchorWeather(w) {
    state.anchor.weather = w;
    saveState();
    scheduleRecompute(10);
  }

  function bindBarEvents() {
    if (!barEl || barEl.dataset.bound === "1") return;
    barEl.dataset.bound = "1";

    barEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".st-story-clock-btn");
      if (!btn) return;
      const act = btn.dataset.act;

      if (act === "+10") adjustAnchorByMinutes(10);
      if (act === "-10") adjustAnchorByMinutes(-10);

      if (act === "rate") {
        state.timeRate = nextRate(state.timeRate);
        saveState();
        renderBar();
        scheduleRecompute(10);
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
        <button class="st-story-clock-btn" data-act="rate">x1</button>
        <button class="st-story-clock-btn" data-act="settings">⚙</button>
      </div>
    `;
    chat.prepend(barEl);

    bindBarEvents();
    renderBar();
  }

  function openSettings() {
    const menu = prompt(
`Story Time v0.29 设置
当前：${hhmm(state.minutes)} | ${state.month}月${state.day}日 | ${state.weather}
锚点：${hhmm(state.anchor.minutes)} | ${state.anchor.month}月${state.anchor.day}日 | ${state.anchor.weather}
自动天气：${state.autoWeather ? "开" : "关"}
时间倍率：${formatRate(state.timeRate)}
会话Key：${chatKey}

1 设置锚点时间(HH:mm)
2 设置锚点日期(M-D)
3 设置锚点天气
4 切换自动天气
5 切换时间倍率
6 重置当前会话状态
7 查看注入状态

输入序号：`
    );
    if (!menu) return;
    const c = menu.trim();

    if (c === "1") {
      const t = prompt("输入时间（如 07:30）", hhmm(state.anchor.minutes));
      if (!t) return;
      const m = t.match(/^([01]?\d|2[0-3])[:：]([0-5]\d)$/);
      if (!m) return alert("时间格式错误");
      setAnchorTime(parseInt(m[1], 10), parseInt(m[2], 10));
      return;
    }

    if (c === "2") {
      const d = prompt("输入日期（如 2-14 或 2/14）", `${state.anchor.month}-${state.anchor.day}`);
      if (!d) return;
      const m = d.match(/^(\d{1,2})[-/](\d{1,2})$/);
      if (!m) return alert("日期格式错误");
      const mm = parseInt(m[1], 10);
      const dd = parseInt(m[2], 10);
      if (mm < 1 || mm > 12 || dd < 1 || dd > daysInMonth(state.anchor.year, mm)) return alert("日期不合法");
      setAnchorDate(mm, dd);
      return;
    }

    if (c === "3") {
      const w = prompt("输入天气：晴 / 多云 / 阴 / 小雨 / 中雨 / 雷阵雨 / 雪 / 雾", state.anchor.weather);
      if (!w) return;
      setAnchorWeather(w.trim());
      return;
    }

    if (c === "4") {
      state.autoWeather = !state.autoWeather;
      saveState();
      scheduleRecompute(10);
      alert(`自动天气已${state.autoWeather ? "开启" : "关闭"}`);
      return;
    }

    if (c === "5") {
      state.timeRate = nextRate(state.timeRate);
      saveState();
      scheduleRecompute(10);
      alert(`当前时间倍率：${formatRate(state.timeRate)}`);
      return;
    }

    if (c === "6") {
      if (!confirm("确定重置当前会话状态吗？")) return;
      state = structuredCloneSafe(DEFAULT_STATE);
      saveState();
      messageTrack.clear();
      lastRenderedSnapshot = "";
      scheduleRecompute(10);
      return;
    }

    if (c === "7") {
      const injected = window.storyTimeDebug?.injected ? "成功" : "失败/未知";
      alert(`提示词注入状态：${injected}\n会话Key：${chatKey}`);
    }
  }

  // ---------- Observer ----------
  function bindChatObserver(chat) {
    if (chatObserver) {
      chatObserver.disconnect();
      chatObserver = null;
    }

    currentChatEl = chat;
    if (!chat) return;

    chatObserver = new MutationObserver(() => {
      // 有任何变动（新增、删除、编辑、流式更新）都重算
      scheduleRecompute(260);
    });

    chatObserver.observe(chat, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function ensureChatBinding() {
    const chat = document.querySelector("#chat");
    if (chat !== currentChatEl) {
      bindChatObserver(chat);
      messageTrack.clear();
      lastRenderedSnapshot = "";
      scheduleRecompute(900);
    }
    ensureBar();
  }

  // ---------- Boot ----------
  function boot() {
    chatKey = getChatKey();
    loadState();

    ensureChatBinding();
    renderBar();
    refreshModelState();

    // 轮询处理聊天切换
    setInterval(() => {
      ensureChatBinding();

      const k = getChatKey();
      if (k !== chatKey) {
        chatKey = k;
        loadState();
        messageTrack.clear();
        lastRenderedSnapshot = "";
        renderBar();
        refreshModelState();
        scheduleRecompute(900);
      }
    }, 800);

    // 启动后首轮重算
    scheduleRecompute(1000);

    console.log("[Story Time v0.29] loaded.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();