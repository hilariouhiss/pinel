// webview 打包：React 应用 → media/webview.js（从仓库根目录运行）
// 用法：node webview-ui/esbuild.js [--watch] [--production]
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["webview-ui/src/index.tsx"],
    bundle: true,
    format: "iife",
    platform: "browser",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    outfile: "media/webview.js",
    logLevel: "silent",
    // SVG 图标以 text 内联进 bundle（webview 内 DOM 渲染，CSS 可覆盖 fill 实现主题自适应）
    loader: {
      ".svg": "text",
    },
    define: {
      "process.env.NODE_ENV": production ? '"production"' : '"development"',
    },
  });
  if (watch) {
    console.log("[webview] watching...");
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error("[webview] build failed:", err);
  process.exit(1);
});
