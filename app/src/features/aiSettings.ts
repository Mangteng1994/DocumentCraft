/**
 * AI 连接设置的数据访问，供设置对话框、Copilot 和科研配图共用。
 */

import { docflow } from "../backend";

export type Provider = "api" | "chatgpt";

export interface AiStatus {
  provider: Provider;
  endpoint: string;
  model: string;
  chatgpt_model: string;
  chatgpt_effort: string;
  account: string | null;
  env_key: boolean;
}

export interface ChatGPTModel {
  name: string;
  slug: string;
  efforts: string[];
}

export const EFFORT_LABELS: Record<string, string> = {
  "": "模型默认",
  none: "不启用（None）",
  minimal: "最低（Minimal）",
  low: "低（Low）",
  medium: "中（Medium）",
  high: "高（High）",
  xhigh: "很高（XHigh）",
  max: "最高（Max）",
};

/** ChatGPT 套餐经 OpenAI 公开 Responses API 请求，与 siwc.RESOURCE 一致。 */
const CHATGPT_RESOURCE = "https://api.openai.com/v1";

export function loadAiStatus(): Promise<AiStatus> {
  return docflow<AiStatus>(["ai", "status"]);
}

/** 外发确认提示中显示的目标地址。 */
export function aiDestination(status: AiStatus): string {
  if (status.provider === "chatgpt") {
    return `ChatGPT 套餐（${CHATGPT_RESOURCE}）`;
  }
  return status.endpoint;
}
