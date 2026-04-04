(() => {
  "use strict";

  const EXT_ID = "story_clock";
  const DEFAULT_STATE = {
    day: 1,
    minutes: 7 * 60 + 30, // 默认 07:30
    weather: "晴"
  };

  let state = { ...DEFAULT_STATE };
  let chatKey = "";
  let barEl = null;
  const processedMes = new WeakSet();

  function getContextSafe() {
    try {
      return window.SillyTavern?.getContext?.() || null;
    } catch {
      return null;
    }
  }

  function getChatKey() {
    const ctx = getContextSafe();
    const id = ctx?.chatId || ctx?.groupId || "global";
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
    } catch {
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

  function renderBar() {
    if (!barEl) return;
    const timeEl = barEl.querySelector("#st-story-clock-time");
    const metaEl = barEl.querySelector("#st-story-clock-meta");
    if (timeEl) timeEl.textContent = hhmm(state.minutes);
    if (metaEl) metaEl.textContent = `第${state.day}天 · ${state.weather}`;
  }

  function setExtensionPrompt(prompt) {
    const ctx = getContextSafe();
    if (!ctx?.setExtensionPrompt) return;

    // 兼容不同版本签名
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
要求：你的环境描写和行为决策必须符合该状态。`;
    setExtensionPrompt(prompt);
  }

  function applyDelta(delta) {
    if (!delta || Number.isNaN(delta)) return;
    state.minutes += delta;
    normalizeTime();
    saveState();
    renderBar();
    refreshModelState();
  }

  function tryParseAbsoluteTime(text) {
    const m = text.match(/([01]?\d|2[0-3])[:：]([0-5]\d)/);
    if (!m) return false;
    const h = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    state.minutes = h * 60 + mm;
    normalizeTime();
    saveState();
    renderBar();
    refreshModelState();
    return true;
  }

  function estimateMinutesByText(text) {
    if (!text) return 0;
    let delta = 0;

    // 显式时长
    for (const m of text.matchAll(/(\d+)\s*分钟(?:后|之后|左右|内)?/g)) {
      delta += parseInt(m[1], 10);
    }
    for (const m of text.matchAll(/(\d+)\s*小时(?:后|之后|左右|内)?/g)) {
      delta += parseInt(m[1], 10) * 60;
    }
    if (/半小时/.test(text)) delta += 30;

    // 行为耗时词典（第一版）
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

    // 没抓到事件时，给一点对话底噪时间
    if (delta === 0 && text.replace(/\s/g, "").length >= 20) {
      delta = 2;
    }

    return Math.min(delta, 240); // 单条最多推进4小时
  }

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

    // 如果消息里有明确时间（如“现在是 12:30”），优先设定绝对时间
    const hasAbsolute = tryParseAbsoluteTime(text);
    if (hasAbsolute) return;

    const delta = estimateMinutesByText(text);
    applyDelta(delta);
  }

  function buildBar() {
    const chat = document.querySelector("#chat");
    if (!chat || document.querySelector("#st-story-clock-bar")) return;

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

    barEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".st-story-clock-btn");
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === "+10") applyDelta(10);
      if (act === "-10") applyDelta(-10);
    });

    renderBar();
  }

  function observeMessages() {
    const chat = document.querySelector("#chat");
    if (!chat) return;

    // 初始化时标记已有消息，避免启动就把历史全算一遍
    chat.querySelectorAll(".mes").forEach((el) => processedMes.add(el));

    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.classList?.contains("mes")) processMesElement(node);
          node.querySelectorAll?.(".mes").forEach(processMesElement);
        }
      }
    });

    obs.observe(chat, { childList: true, subtree: true });
  }

  function boot() {
    chatKey = getChatKey();
    loadState();
    buildBar();
    renderBar();
    refreshModelState();
    observeMessages();

    // 监听切换聊天
    setInterval(() => {
      const k = getChatKey();
      if (k !== chatKey) {
        chatKey = k;
        loadState();
        renderBar();
        refreshModelState();
      }
    }, 1200);

    console.log("[Story Clock] loaded.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();