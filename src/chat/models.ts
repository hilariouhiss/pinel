import type { Model } from "../rpc/protocol";

/**
 * 防御解析 get_available_models 响应数据（参照 commands.ts 的防御思路）。
 *
 * 输入是 RPC 响应的 `data` 字段（unknown）。规则：结构不符返回 [];
 * 逐项跳过缺失/类型错误；模型项须有非空 id/name/provider 字符串
 * （set_model 依赖 provider+modelId 复合键，缺一不可用）。
 */
export function parseModels(data: unknown): Model[] {
  if (typeof data !== "object" || data === null) {
    return [];
  }
  const raw = (data as { models?: unknown }).models;
  if (!Array.isArray(raw)) {
    return [];
  }
  const models: Model[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const entry = item as Record<string, unknown>;
    const { id, name, provider } = entry;
    if (
      typeof id !== "string" ||
      id.trim().length === 0 ||
      typeof name !== "string" ||
      name.trim().length === 0 ||
      typeof provider !== "string" ||
      provider.trim().length === 0
    ) {
      continue; // 缺失/非字符串/空白：跳过该条，不拖垮整个列表
    }
    models.push({ id, name, provider });
  }
  return models;
}

/**
 * 防御解析 get_available_thinking_levels 响应数据。
 *
 * 规则：结构不符返回 []; 逐项跳过非字符串/空白项；不假定 `["off"]`
 * 语义（真实 pi 对不支持思考的模型返回 ["off"]，但防御层不依赖）。
 */
export function parseThinkingLevels(data: unknown): string[] {
  if (typeof data !== "object" || data === null) {
    return [];
  }
  const raw = (data as { levels?: unknown }).levels;
  if (!Array.isArray(raw)) {
    return [];
  }
  const levels: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.trim().length === 0) {
      continue;
    }
    levels.push(item);
  }
  return levels;
}
