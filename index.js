(() => {
  "use strict";

  const EXT_ID = "story_time";
  const DEFAULT_STATE = {
    day: 1,
    minutes: 7 * 60 + 30, // 07:30
    weather: "晴"
  };

  let state = { ...DEFAULT_STATE };
  let chatKey = "";
  let barEl = null;
  let currentChatEl = null;
  let chatObserver = null;
  const processedMes = new WeakSet();

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
    const id = ctx?.chatId || ctx?.groupId || ctx?.characterId || "global";
    return `${EXT_ID}:${id}`;
  }

  // ---------- State ----------
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

  function normalizeTime() {
    while (state.minutes >= 1440) {
      state.minutes -= 1440;
      state.day += 1;
    }
    while (state.minutes < 0) {
      state.minutes += 1440;
      state.day = Math.max(1, state.day - 1);
    }
  }

  function hhmm(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  // ---------- UI ----------
  function renderBar() {
    if (!barEl) return;
    const timeEl = barEl.querySelector("#st-story-clock-time");
    const metaEl = barEl.querySelector("#st-story-clock-meta");
    if (timeEl) timeEl.textContent = hhmm(state.minutes);
    if (metaEl) metaEl.textContent = `第${state.day}天 · ${state.weather}`;
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
        <div id="st-story-clock-meta">第1天 · 晴</div>
      </div>
      <div id="st-story-clock-controls">
        <button class="st-story-clock-btn" data-act="-10">-10m</button>
        <button class="st-story-clock-btn" data-act="+10">+10m</button>
      </div>
    `;
    chat.prepend(barEl);

    bindBarEvents();
    renderBar();
  }

  // ---------- Prompt Injection ----------
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
    const prompt = `[剧情状态]
- 当前时间: ${hhmm(state.minutes)}
- 当前日期: 第${state.day}天
- 当前天气: ${state.weather}
要求：
1) 你的环境描写与行为应符合当前状态；
2) 不要随意改写本状态，除非剧情明确出现时间跳转。`;
    setExtensionPrompt(prompt);
  }

  // ---------- Time Logic ----------
  function applyDelta(delta) {
    if (!delta || Number.isNaN(delta)) return;
    state.minutes += delta;
    normalizeTime();
    saveState();
    renderBar();
    refreshModelState();
  }

  function tryParseAbsoluteTime(text) {
    if (!text) return false;

    // 1) 12:30 / 7：05
    let m = text.match(/([01]?\d|2[0-3])[:：]([0-5]\d)/);
    if (m) {
      const h = parseInt(m[1], 10);
      const mm = parseInt(m[2], 10);
      state.minutes = h * 60 + mm;
      normalizeTime();
      saveState();
      renderBar();
      refreshModelState();
      return true;
    }

    // 2) 7点30 / 7点30分
    m = text.match(/([01]?\d|2[0-3])\s*点\s*([0-5]?\d)?\s*分?/);
    if (m) {
      const h = parseInt(m[1], 10);
      const mm = m[2] ? parseInt(m[2], 10) : 0;
      state.minutes = h * 60 + mm;
      normalizeTime();
      saveState();
      renderBar();
      refreshModelState();
      return true;
    }

    return false;
  }

  function estimateMinutesByText(text) {
  if (!text) return 0;
  let delta = 0;
  const clean = text.replace(/\s+/g, "");

  // 显式时长
  for (const m of text.matchAll(/(\d+)\s*分钟(?:后|之后|左右|内)?/g)) {
    delta += parseInt(m[1], 10);
  }
  for (const m of text.matchAll(/(\d+)\s*小时(?:后|之后|左右|内)?/g)) {
    delta += parseInt(m[1], 10) * 60;
  }
  if (/半小时/.test(text)) delta += 30;

  // 事件词典
  const rules = [
    [/起床|醒来/, 5],
    [/洗漱|刷牙|洗脸/, 10],
    [/换衣|穿好衣服|穿衣服/, 10],
    [/洗澡|沐浴/, 20],
    [/做饭|下厨/, 30],
    [/吃早餐|吃早饭/, 20],
    [/吃午饭|吃中饭/, 30],
    [/吃晚饭/, 35],
    [/通勤|赶路|坐车|开车|乘车/, 30],
    [/散步/, 15],
    [/上课|工作|学习/, 60],
    [/睡觉|入睡/, 8 * 60]
  ];

  for (const [reg, mins] of rules) {
    if (reg.test(text)) delta += mins;
  }

  // 闲聊兜底（让普通聊天也推进）
  if (delta === 0) {
    const len = clean.length;
    if (len <= 4) delta = 1;        // 嗯、好、哈哈
    else if (len <= 20) delta = 2;  // 短闲聊
    else if (len <= 60) delta = 3;  // 普通一段
    else delta = 5;                 // 较长内容
  }

  return Math.min(delta, 240);
}

  // ---------- Message Processing ----------
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
    processedMes.add(mesEl);

    const text = extractMessageText(mesEl);
    if (!text) return;

    // 绝对时间优先
    if (tryParseAbsoluteTime(text)) return;

    const delta = estimateMinutesByText(text);
    applyDelta(delta);
  }

  // ---------- Chat Observer ----------
  function bindChatObserver(chat) {
    if (chatObserver) {
      chatObserver.disconnect();
      chatObserver = null;
    }

    currentChatEl = chat;
    if (!chat) return;

    // 不重算历史消息
    chat.querySelectorAll(".mes").forEach((el) => processedMes.add(el));

    chatObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.classList?.contains("mes")) processMesElement(node);
          node.querySelectorAll?.(".mes").forEach(processMesElement);
        }
      }
    });

    chatObserver.observe(chat, { childList: true, subtree: true });
  }

  function ensureChatBinding() {
    const chat = document.querySelector("#chat");
    if (chat !== currentChatEl) {
      bindChatObserver(chat);
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

    // 处理切换角色卡/关闭聊天导致DOM重建
    setInterval(() => {
      ensureChatBinding();

      const k = getChatKey();
      if (k !== chatKey) {
        chatKey = k;
        loadState();
        renderBar();
        refreshModelState();
      }
    }, 800);

    console.log("[Story Time] loaded.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();