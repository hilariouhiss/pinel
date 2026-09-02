import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * Pinel 插件安装检测与安装执行（宿主端；无 vscode 依赖，可单测）。
 *
 * 插件 = npm 包 `@hilariouhiss/pinel`（../pi/ 目录发布），用户经
 * `pi install npm:@hilariouhiss/pinel` 安装（写入 ~/.pi/agent/settings.json
 * packages 数组）。宿主只读 settings.json 判安装态（等价 pi list，免 spawn）。
 *
 * 不复活策略：用户 pi remove 卸载后（曾安装标记 + 列表消失 = "removed"），
 * 不再自动提示/安装，仅保留手动入口；「安装」动作成功后清除标记。
 * 曾安装标记存 vscode globalState（controller 持有），此处只接收布尔值。
 */

/** pi 包 source spec（npm 形式；pi install 的规范格式）。 */
export const PINEL_PACKAGE_SOURCE = "npm:@hilariouhiss/pinel";

/** 安装态：installed 已装 / offer 从未安装（提示一键安装）/ removed 用户已卸载（不复活）。 */
export type PinelPluginState = "installed" | "offer" | "removed";

/**
 * 安装态决策（纯函数）：packages 为 settings.json 的 packages 数组（未知形状容缺）。
 * - 列表含 PINEL_PACKAGE_SOURCE（字符串或对象 source 字段）→ installed
 * - 不含且曾安装标记 → removed
 * - 不含且无标记 → offer
 */
export function decidePinelPluginState(
  packages: unknown,
  previouslyInstalled: boolean,
): PinelPluginState {
  if (Array.isArray(packages)) {
    for (const pkg of packages) {
      const source =
        typeof pkg === "string"
          ? pkg
          : pkg && typeof pkg === "object"
            ? ((pkg as Record<string, unknown>).source as string | undefined)
            : undefined;
      if (source === PINEL_PACKAGE_SOURCE) {
        return "installed";
      }
    }
  }
  return previouslyInstalled ? "removed" : "offer";
}

/**
 * 读取 agent settings.json 的 packages 数组（文件缺失/损坏 → []：检测链路
 * 不因配置损坏抛错，状态按未安装处理；文件损坏时 pi 自身也会报错）。
 */
export async function readAgentPackages(settingsPath: string): Promise<unknown[]> {
  let raw: string;
  try {
    raw = await fs.readFile(settingsPath, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }
  const packages = (parsed as Record<string, unknown>).packages;
  return Array.isArray(packages) ? packages : [];
}

/** 全局 agent settings.json 路径（默认 ~/.pi/agent/settings.json；尊重 PI_CODING_AGENT_DIR）。 */
export function agentSettingsPath(
  homeDir: string,
  env: { PI_CODING_AGENT_DIR?: string } = process.env,
): string {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || path.join(homeDir, ".pi", "agent");
  return path.join(agentDir, "settings.json");
}
