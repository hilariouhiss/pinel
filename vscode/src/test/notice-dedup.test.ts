import * as assert from "assert";
import { isDuplicateNotice, NOTICE_DEDUP_WINDOW_MS } from "../chat/notice-dedup";

suite("notice-dedup 单元测试", () => {
  const base = { level: "info", text: "Ponytail loaded: full", at: 1000 };

  test("同 level+text 且窗口内 → 判重（pi 双重 emit 场景，~80ms 间隔）", () => {
    assert.strictEqual(isDuplicateNotice(base, "info", "Ponytail loaded: full", 1080), true);
  });

  test("超出窗口 → 不判重", () => {
    assert.strictEqual(
      isDuplicateNotice(base, "info", "Ponytail loaded: full", 1000 + NOTICE_DEDUP_WINDOW_MS),
      false,
    );
  });

  test("text 或 level 不同 → 不判重", () => {
    assert.strictEqual(isDuplicateNotice(base, "warning", "Ponytail loaded: full", 1010), false);
    assert.strictEqual(isDuplicateNotice(base, "info", "other text", 1010), false);
  });

  test("无历史（null）→ 不判重", () => {
    assert.strictEqual(isDuplicateNotice(null, "info", "x", 1000), false);
  });
});
