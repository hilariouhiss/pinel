// 长命测试子进程：把自身 pid 写入 argv[2] 指定的文件后常驻。
// 用于 stop.test.ts 验证 RpcClient.stop() 等待进程真实退出。
//
// stdin EOF（父进程关闭管道）时退出，模拟 pi 的优雅退出路径；
// 环境变量 PINEL_LONG_NO_EOF=1 时保持常驻（用于兜底硬杀路径测试）。
"use strict";
const fs = require("fs");

fs.writeFileSync(process.argv[2], String(process.pid));
process.stdin.resume();
process.stdin.on("end", () => {
  if (process.env.PINEL_LONG_NO_EOF === "1") {
    return; // 保持常驻：不响应 EOF
  }
  process.exit(0);
});
setInterval(() => {}, 1000);
