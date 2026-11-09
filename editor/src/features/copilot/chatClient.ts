/**
 * 调用 docflow chat 的流式对话。AI 连接沿用「设置 → AI 连接」中保存的配置。
 */

import { cancelDocflow, docflowStream } from "../../backend";
import { useAppStore } from "../../store";

export interface ApiMessage {
  role: "user" | "assistant";
  content: string;
}

interface DeltaLine {
  type?: string;
  text?: string;
}

export interface ChatRequest {
  job: string;
  done: Promise<void>;
  cancel: () => Promise<void>;
}

/** 发起一次流式对话，每段文字回调 onDelta。 */
export function streamChat(system: string, messages: ApiMessage[], onDelta: (text: string) => void): ChatRequest {
  const apiKey = useAppStore.getState().apiKey;
  const handle = docflowStream(
    ["chat"],
    (value) => {
      const line = value as DeltaLine;
      if (line.type === "delta" && typeof line.text === "string") {
        onDelta(line.text);
      }
    },
    { input: { system, messages }, apiKey },
  );
  return {
    job: handle.job,
    done: handle.done.then(() => undefined),
    cancel: () => cancelDocflow(handle.job),
  };
}
