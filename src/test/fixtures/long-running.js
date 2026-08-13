// 长命测试子进程：把自身 pid 写入 argv[2] 指定的文件后常驻。
// 用于 stop.test.ts 验证 RpcClient.stop() 等待进程真实退出。
"use strict";
const fs = require("fs");

fs.writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
