/**
 * 模型默认配置纯函数模块（无 vscode 依赖，可单测）。
 * 存 pi 全局 settings.json（`<agentDir>/settings.json`）：
 * - 默认模型/思考强度 = pi 启动键 `defaultProvider` + `defaultModel` + `defaultThinkingLevel`
 *   （pi 启动时读，下一会话生效）；
 * - 强/弱模型预设 = `pinel.modelRoles.{strong,weak}`（"provider:id" 复合键，Pinel 自有
 *   预设，暂不驱动行为）。
 */

import type { SettingsObject } from "./extensions";

/** 模型默认配置（webview 协议镜像见 webview-ui/src/types.ts）。 */
export interface ModelDefaults {
  /** 默认模型复合键 "provider:id"（pi 设置 defaultProvider/defaultModel 均缺失时为 null）。 */
  defaultModelKey: string | null;
  /** 默认思考强度（pi 设置 defaultThinkingLevel）。 */
  defaultThinkingLevel: string | null;
  /** 强（贵）模型预设键。 */
  strongKey: string | null;
  /** 弱（便宜）模型预设键。 */
  weakKey: string | null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** 防御解析 pinel.modelRoles 对象。 */
function readRoles(settings: SettingsObject): Record<string, unknown> | undefined {
  const pinel = settings.pinel;
  if (!pinel || typeof pinel !== "object" || Array.isArray(pinel)) {
    return undefined;
  }
  const roles = (pinel as Record<string, unknown>).modelRoles;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) {
    return undefined;
  }
  return roles as Record<string, unknown>;
}

export function readModelDefaults(settings: SettingsObject): ModelDefaults {
  const provider = str(settings.defaultProvider);
  const model = str(settings.defaultModel);
  const roles = readRoles(settings);
  return {
    defaultModelKey: provider && model ? `${provider}:${model}` : null,
    defaultThinkingLevel: str(settings.defaultThinkingLevel) ?? null,
    strongKey: str(roles?.strong) ?? null,
    weakKey: str(roles?.weak) ?? null,
  };
}

/** 写默认模型（pi 启动键）。原地改 settings 对象，落盘由调用方负责。 */
export function writeDefaultModel(settings: SettingsObject, provider: string, modelId: string): void {
  settings.defaultProvider = provider;
  settings.defaultModel = modelId;
}

/** 写默认思考强度。原地改 settings 对象。 */
export function writeDefaultThinkingLevel(settings: SettingsObject, level: string): void {
  settings.defaultThinkingLevel = level;
}

/** 写强/弱模型预设（pinel.modelRoles.<role>），保留其余键。原地改 settings 对象。 */
export function writeModelRole(settings: SettingsObject, role: "strong" | "weak", key: string): void {
  const raw = settings.pinel;
  const pinel =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  pinel.modelRoles = { ...readRoles(settings), [role]: key };
  settings.pinel = pinel;
}
