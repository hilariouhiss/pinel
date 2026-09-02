/**
 * stream-render 自检：守卫「流式渲染两处关键约定」不被误改。
 * 挂入 npm run compile 门：约定被误删时编译即红。仅守卫代码存在，不验证渲染（渲染由像素差分验证）。
 *
 * 1. 占位槽 key = m-${messages.length}（= 落定消息将获得的 key，两段消息 map 均为绝对
 *    索引键）+ assistant message 到达同帧清 streamBlocks → settle 原地复用 DOM，
 *    不重挂载（msg-in 入场动效/卡片展开态不重放——否则 running→done 呈现"删旧卡加新卡"）。
 * 2. 块键统一 blk-${i}（流式/落定两分支一致，块级也原地复用）；
 *    仅最后一个块 live（出现下一块即上一块已结束，thinking/正文不停留在流式态）。
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

const app = readFileSync("webview-ui/src/App.tsx", "utf8");
const msgView = readFileSync("webview-ui/src/components/MessageView.tsx", "utf8");

// 占位槽与落定消息同 key（React 按 key 原地复用）
assert.match(app, /key=\{`m-\$\{messages\.length\}`\}/, "App.tsx 流式占位槽必须以 m-${messages.length} 为 key（与落定消息 key 一致）");
// assistant 落定与清流同帧（占位槽同帧切换到权威消息，不留双渲染帧）
assert.match(app, /msg\.message\.role === "assistant"\)\s*\{\s*setStreamBlocks\(\[\]\);/, "App.tsx assistant message 到达时必须同帧 setStreamBlocks([])");

// 块键统一：流式分支与落定分支同前缀，块级 DOM settle 时原地复用
assert.match(msgView, /key=\{`blk-\$\{i\}`\}/, "MessageView.tsx 必须用 blk-${i} 块键");
assert.strictEqual(msgView.match(/key=\{`blk-\$\{i\}`\}/g)?.length, 2, "MessageView.tsx 流式与落定两分支都必须用 blk-${i} 块键");
// 仅末块 live：出现下一块 = 上一块已结束
assert.match(msgView, /live=\{i === streamBlocks\.length - 1\}/, "MessageView.tsx 流式块必须仅最后一个 live（live={i === streamBlocks.length - 1}）");

console.log("stream-render check OK");
