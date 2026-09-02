// 悬浮条规则纯函数自检（node scripts/roundbar-check.mjs；Node 24 原生 TS 剥离）
import { resolveVisibleUser } from "../webview-ui/src/roundbar-rule.ts";

let failed = 0;
function check(name, got, want) {
  if (got !== want) {
    failed++;
    console.error(`FAIL ${name}: got ${got}, want ${want}`);
  }
}

// —— 贴底 + 最近一条仍在视口内（首条消息刚发送/会话尚短）→ 隐藏 ——
check("stick-bottom: 唯一一条可见", resolveVisibleUser([100], true), -1);
check("stick-bottom: 最近一条可见", resolveVisibleUser([-500, -300, 50], true), -1);
// —— 贴底 + 最近一条已滚出（顶部越过视口顶）→ 钉住最近 ——
check("stick-bottom: 最近一条已滚出", resolveVisibleUser([-500, -300, -50], true), 2);
// 元素缺失（渲染瞬态）→ 保守钉住
check("stick-bottom: 最近一条位置未知", resolveVisibleUser([-500, -300, null], true), 2);

// —— 非贴底既有规则回归 ——
check("non-stick: 中间回合 → 发起消息", resolveVisibleUser([-500, 100, 200], false), 0);
check("non-stick: 视口顶在最早消息之上 → 隐藏", resolveVisibleUser([100, 200], false), -1);
check("non-stick: 全部滚出 → 最近一条", resolveVisibleUser([-300, -100], false), 1);
check("空列表 → 隐藏", resolveVisibleUser([], false), -1);

if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("roundbar-check: all passed");
