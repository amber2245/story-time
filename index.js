(() => {
  "use strict";

  const EXT_ID = "story_time";

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
    autoWeather: true
  };

  let state = { ...DEFAULT_STATE };
  let chatKey = "";
  let barEl = null;
  let currentChatEl = null;
  let chatObserver = null;
  const processedMes = new WeakSet();

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
    const id = ctx?.chatId || ctx?.groupId || ctx?.characterId || "global";
    return `${EXT_ID}:${id}`;
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

  function commitState() {
    saveState();
    renderBar();
    refreshModelState();
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
      if (act === "+10") applyDelta(10);
      if (act === "-10") applyDelta(-10);
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

  // ---------- 注入模型 ----------
  function setExtensionPrompt(prompt) {
    const ctx = getContextSafe();
    if (!ctx?.setExtensionPrompt) return;

    const tries = [
      () => ctx.setExtensionPrompt(EXT_ID, prompt, 1, 0, true, "system"),
      () => ctx.setExtensionPrompt(EXT_ID, prompt, 1, 0),
      () => ctx.setExtensionPrompt(EXT_ID, prompt)
    ];

    for (const t of tries) {
      try {
        t();
        return;
      } catch (_) {}
    }
  }

  function refreshModelState() {
    const festival = getFestival();
    const prompt = `[剧情状态]
- 时间: ${hhmm(state.minutes)}（${getPhase(state.minutes)}）
- 日期: ${state.month}月${state.day}日
- 天气: ${state.weather}
- 节日: ${festival || "无"}
- 时段提示: ${getMealHint(state.minutes)}

规则：
1) 环境描写与行为要符合时间/天气/节日；
2) 时间推进以系统状态为准，不要机械固定分钟；
3) 只有出现明确时间词或剧情显著进展时再大幅跳时。`;
    setExtensionPrompt(prompt);
  }

  // ---------- 时间解析（分层） ----------
  function applyDelta(delta) {
    if (!delta || Number.isNaN(delta)) return;
    state.minutes += delta;
    normalizeTime();
    commitState();
  }

  function setAbsoluteTime(h, m) {
    state.minutes = h * 60 + m;
    normalizeTime();
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

    // 十三 / 二十 / 二十三
    if (str.includes("十")) {
      const [a, b] = str.split("十");
      const tens = a ? (map[a] || 0) : 1;
      const ones = b ? (map[b] || 0) : 0;
      return tens * 10 + ones;
    }

    return NaN;
  }

  // Layer 1: 绝对时间锚点
  function tryParseAbsoluteTime(text) {
    let m = text.match(/([01]?\d|2[0-3])[:：]([0-5]\d)/);
    if (m) {
      setAbsoluteTime(parseInt(m[1], 10), parseInt(m[2], 10));
      return true;
    }

    m = text.match(/([01]?\d|2[0-3])\s*点\s*([0-5]?\d)?\s*分?/);
    if (m) {
      setAbsoluteTime(parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0);
      return true;
    }
    return false;
  }

  function tryParsePeriodAnchor(text) {
    let touched = false;

    if (/(第二天|次日|翌日|隔天)/.test(text)) {
      shiftDate(1);
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
      commitState();
      return true;
    }

    return false;
  }

  // Layer 2: 显式时长
  function parseExplicitDuration(text) {
    let minutes = 0;
    let hit = false;

    // X小时
    for (const m of text.matchAll(/([一二两三四五六七八九十半\d]+)\s*小时(?:后|之后|左右|内)?/g)) {
      const n = parseCNNumber(m[1]);
      if (!Number.isNaN(n)) {
        minutes += Math.round(n * 60);
        hit = true;
      }
    }

    // X分钟
    for (const m of text.matchAll(/([一二两三四五六七八九十\d]+)\s*分钟(?:后|之后|左右|内)?/g)) {
      const n = parseCNNumber(m[1]);
      if (!Number.isNaN(n)) {
        minutes += Math.round(n);
        hit = true;
      }
    }

    // 半小时
    if (/半个?小时/.test(text)) {
      minutes += 30;
      hit = true;
    }

    // 一刻钟/两刻钟
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

  // Layer 3: 事件类别推断（非穷举）
  const CATEGORY_RULES = [
    { name: "meal", reg: /(吃(完|过|了)?(饭|早餐|早饭|午饭|中饭|午餐|晚饭|晚餐|宵夜)?|用餐|进餐)/, range: [18, 45] },
    { name: "cook", reg: /(做饭|下厨|烹饪|备餐|准备.*(饭|餐))/, range: [20, 50] },
    { name: "hygiene", reg: /(洗漱|刷牙|洗脸|梳洗|化妆|整理仪容|打理自己)/, range: [8, 20] },
    { name: "dress", reg: /(换(好)?衣服|更衣|穿好衣服|穿戴整齐)/, range: [6, 15] },
    { name: "commute", reg: /(出门|赶路|通勤|坐车|开车|乘车|打车|地铁|公交|骑车|步行前往|前往)/, range: [12, 45] },
    { name: "work_study", reg: /(上课|工作|学习|开会|训练|写作业|值班|处理文件)/, range: [35, 120] },
    { name: "social", reg: /(约会|聚会|会面|拜访|长谈|闲聊了一会|聊了很久)/, range: [15, 60] },
    { name: "shopping", reg: /(购物|采购|逛街|商场|买菜)/, range: [20, 90] },
    { name: "exercise", reg: /(跑步|锻炼|健身|打球|游泳|运动)/, range: [20, 80] },
    { name: "rest", reg: /(休息|小憩|午睡|躺一会|闭目养神)/, range: [10, 50] },
    { name: "sleep", reg: /(睡觉|入睡|睡着|过夜|补觉)/, range: [360, 540] },
    { name: "medical", reg: /(包扎|治疗|看医生|就诊|输液|护理)/, range: [20, 90] }
  ];

  function estimateCategoryMinutes(text) {
    let minutes = 0;
    let count = 0;

    for (const rule of CATEGORY_RULES) {
      if (!rule.reg.test(text)) continue;
      count += 1;

      let [min, max] = rule.range;

      // meal 按时段微调
      if (rule.name === "meal") {
        const m = state.minutes;
        if (m >= 330 && m <= 570) [min, max] = [15, 30];      // 早餐区
        else if (m >= 660 && m <= 870) [min, max] = [25, 45]; // 午餐区
        else if (m >= 1020 && m <= 1260) [min, max] = [30, 55];// 晚餐区
      }

      minutes += pickRange(min, max, `${text}|${rule.name}|${state.minutes}`);
    }

    return { minutes, count };
  }

  // Layer 4: 叙事流逝推断
  function estimateNarrativeMinutes(text) {
    let n = 0;

    if (/(不知不觉(间)?|转眼(间)?|一晃|过了许久|良久)/.test(text)) {
      n += pickRange(10, 30, text + "|flow_strong");
    }

    if (/(过了一会儿?|过了一阵子?|片刻后|随后|接着|然后|不久后)/.test(text)) {
      n += pickRange(3, 12, text + "|flow_mid");
    }

    if (/(天色渐暗|夜幕降临|天亮了|日出|日落|黄昏|傍晚时分)/.test(text)) {
      n += pickRange(20, 70, text + "|scene_daylight");
    }

    if (/(外面|窗外).*(下起|开始下).*(雨|雪)|雨越下越大|突然下雨/.test(text)) {
      n += pickRange(6, 20, text + "|scene_weather_shift");
    }

    return n;
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

    const jitter = hashText(clean) % 2; // 0~1，防机械
    return base + jitter;
  }

  function estimateMinutesByText(text) {
    if (!text) return 0;

    const explicit = parseExplicitDuration(text);
    const category = estimateCategoryMinutes(text);
    const narrative = estimateNarrativeMinutes(text);

    let total = 0;

    if (explicit.hit) {
      // 显式时长主导，其他层只给小幅修正，防爆炸
      total = explicit.minutes + Math.round((category.minutes + narrative) * 0.35);
    } else {
      total = category.minutes + narrative;

      // 多类别事件加成：同句做了多件事
      if (category.count >= 2 && total > 0) {
        const factor = 1 + Math.min(0.35, (category.count - 1) * 0.1);
        total = Math.round(total * factor);
      }
    }

    if (total <= 0) {
      total = estimateFallbackMinutes(text);
    }

    // 安全上限：单条最多 6 小时
    return Math.min(total, 360);
  }

  // ---------- 状态解析 ----------
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

  // ---------- 消息处理 ----------
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

    // 天气/日期先解析（可与时间并存）
    tryParseWeather(text);
    tryParseDate(text);

    // Layer 1: 锚点（命中就结束）
    if (tryParseAbsoluteTime(text)) return;
    if (tryParsePeriodAnchor(text)) return;

    // Layer 2~5
    const delta = estimateMinutesByText(text);
    applyDelta(delta);
  }

  // ---------- 设置 ----------
  function openSettings() {
    const menu = prompt(
`Story Time v0.25 设置
当前：${hhmm(state.minutes)} | ${state.month}月${state.day}日 | ${state.weather}
自动天气：${state.autoWeather ? "开" : "关"}

1 设置时间(HH:mm)
2 设置日期(M-D)
3 设置天气
4 切换自动天气
5 重置当前会话状态

输入序号：`
    );
    if (!menu) return;
    const c = menu.trim();

    if (c === "1") {
      const t = prompt("输入时间（如 07:30）", hhmm(state.minutes));
      if (!t) return;
      const m = t.match(/^([01]?\d|2[0-3])[:：]([0-5]\d)$/);
      if (!m) return alert("时间格式错误");
      setAbsoluteTime(parseInt(m[1], 10), parseInt(m[2], 10));
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

    // 不重算历史
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

    console.log("[Story Time v0.25] loaded.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();