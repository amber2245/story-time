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