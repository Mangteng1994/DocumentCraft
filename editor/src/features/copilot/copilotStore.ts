/**
 * Copilot 对话状态与操作：发送、停止、重新生成、编辑、删除、新对话、读取与自动保存记录。
 *
 * 交互对应 Obsidian Copilot 的 Quick Chat：当前笔记默认作为常驻上下文徽标；选区和手动添加的笔记
 * 只随下一条消息发送；「/命令」在发送时展开为保存的提示词；工作区检索模式会先在本地检索摘录。
 */

import { create } from "zustand";
import { errorText } from "../../backend";
import { getSettings } from "../../settings/settingsStore";
import { useAppStore } from "../../store";
import { streamChat, type ApiMessage, type ChatRequest } from "./chatClient";
import {
  buildContextBlock,
  composeSystemPrompt,
  contextLabel,
  mentionedNotes,
  sameContext,
  searchWorkspace,
  type ContextItem,
  type SearchSource,
} from "./context";
import { loadCommands, renderPrompt, type CustomCommand } from "./customCommands";
import { loadConversation, newConversationPath, saveConversation } from "./history";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** 界面显示与保存的正文：用户原话或回答。 */
  text: string;
  /** 随用户消息发送的 <context> 块，编辑或重新生成时沿用。 */
  contextBlock: string;
  contextLabels: string[];
  sources: SearchSource[];
  timestamp: number;
  error?: string;
}

interface CopilotState {
  messages: ChatMessage[];
  streamingId: string | null;
  /** 手动添加的一次性上下文（笔记）。 */
  attachments: ContextItem[];
  /** 编辑器中最近一次选中的文字，作为一次性上下文。 */
  selection: ContextItem | null;
  /** 用户移除当前笔记徽标后，本对话不再自动附带当前笔记。 */
  activeNoteDetached: boolean;
  draft: string;
  conversationPath: string | null;
  commands: CustomCommand[];
  modelLabel: string;
  error: string;

  setDraft: (draft: string) => void;
  setSelection: (selection: ContextItem | null) => void;
  addAttachment: (item: ContextItem) => void;
  removeAttachment: (item: ContextItem) => void;
  detachActiveNote: (detached: boolean) => void;
  setModelLabel: (label: string) => void;
  reloadCommands: () => Promise<void>;
  send: (text: string) => Promise<void>;
  stop: () => Promise<void>;
  regenerate: (assistantId: string) => Promise<void>;
  editUserMessage: (id: string, text: string) => Promise<void>;
  deleteMessage: (id: string) => void;
  newChat: () => void;
  openConversation: (path: string) => Promise<void>;
}

let currentRequest: ChatRequest | null = null;
let idCounter = 0;

function newId(): string {
  idCounter += 1;
  return `m${Date.now()}-${idCounter}`;
}

/** 把消息列表转成发给模型的多轮对话。 */
function toApiMessages(messages: ChatMessage[]): ApiMessage[] {
  const result: ApiMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      if (message.text && !message.error) {
        result.push({ role: "assistant", content: message.text });
      }
      continue;
    }
    const content = message.contextBlock ? `${message.text}\n\n${message.contextBlock}` : message.text;
    result.push({ role: "user", content });
  }
  return result;
}

/** 展开开头的 /命令：/命令名 后面的文字作为附加要求。 */
async function expandSlashCommand(text: string, commands: CustomCommand[], selectionText: string | null): Promise<string> {
  if (!text.startsWith("/")) {
    return text;
  }
  const sorted = [...commands].sort((left, right) => right.name.length - left.name.length);
  const command = sorted.find((item) => text === `/${item.name}` || text.startsWith(`/${item.name} `) || text.startsWith(`/${item.name}\n`));
  if (!command) {
    return text;
  }
  const extra = text.slice(command.name.length + 1).trim();
  const activeNotePath = useAppStore.getState().filePath;
  const prompt = await renderPrompt(command.prompt, { selection: selectionText, activeNotePath });
  return extra ? `${prompt}\n\n${extra}` : prompt;
}

export const useCopilot = create<CopilotState>((set, get) => {
  const autosave = async () => {
    if (!getSettings().copilot.autosave) {
      return;
    }
    try {
      await saveCurrentConversation();
    } catch (error) {
      set({ error: `对话未能自动保存：${errorText(error)}` });
    }
  };

  /** 以 history 为上下文生成一条新回答，追加到消息末尾。 */
  const respond = async (history: ChatMessage[]) => {
    const assistant: ChatMessage = {
      id: newId(),
      role: "assistant",
      text: "",
      contextBlock: "",
      contextLabels: [],
      sources: history[history.length - 1]?.sources ?? [],
      timestamp: Date.now(),
    };
    set({ messages: [...history, assistant], streamingId: assistant.id, error: "" });
    const system = composeSystemPrompt(getSettings().copilot.systemPrompt);
    const append = (delta: string) => {
      set((state) => ({
        messages: state.messages.map((message) => (message.id === assistant.id ? { ...message, text: message.text + delta } : message)),
      }));
    };
    const request = streamChat(system, toApiMessages(history), append);
    currentRequest = request;
    try {
      await request.done;
    } catch (error) {
      const message = errorText(error);
      set((state) => ({
        messages: state.messages.map((item) => (item.id === assistant.id ? { ...item, error: message } : item)),
      }));
    } finally {
      if (currentRequest === request) {
        currentRequest = null;
      }
      set({ streamingId: null });
    }
    await autosave();
  };

  return {
    messages: [],
    streamingId: null,
    attachments: [],
    selection: null,
    activeNoteDetached: false,
    draft: "",
    conversationPath: null,
    commands: [],
    modelLabel: "",
    error: "",

    setDraft: (draft) => set({ draft }),
    setSelection: (selection) => set({ selection }),
    addAttachment: (item) => {
      const exists = get().attachments.some((existing) => sameContext(existing, item));
      if (!exists) {
        set({ attachments: [...get().attachments, item] });
      }
    },
    removeAttachment: (item) => set({ attachments: get().attachments.filter((existing) => !sameContext(existing, item)) }),
    detachActiveNote: (detached) => set({ activeNoteDetached: detached }),
    setModelLabel: (modelLabel) => set({ modelLabel }),

    reloadCommands: async () => {
      try {
        const commands = await loadCommands();
        set({ commands });
      } catch (error) {
        set({ error: `命令读取失败：${errorText(error)}` });
      }
    },

    send: async (rawText) => {
      const text = rawText.trim();
      if (!text || get().streamingId) {
        return;
      }
      const settings = getSettings().copilot;
      const { filePath } = useAppStore.getState();
      const { selection, attachments, activeNoteDetached, commands } = get();

      const items: ContextItem[] = [];
      if (filePath && settings.autoAttachActiveNote && !activeNoteDetached) {
        items.push({ kind: "activeNote", path: filePath });
      }
      if (selection) {
        items.push(selection);
      }
      for (const item of attachments) {
        items.push(item);
      }
      for (const path of mentionedNotes(text)) {
        const note: ContextItem = { kind: "note", path };
        const duplicate = items.some((existing) => existing.kind !== "selection" && existing.path === path);
        if (!duplicate) {
          items.push(note);
        }
      }

      set({ draft: "", selection: null, attachments: [], error: "" });
      try {
        const selectionText = selection && selection.kind === "selection" ? selection.text : null;
        const expanded = await expandSlashCommand(text, commands, selectionText);
        const sources = settings.mode === "vault" ? await searchWorkspace(text) : [];
        const contextBlock = await buildContextBlock(items, sources);
        const labels = items.map(contextLabel);
        if (sources.length > 0) {
          labels.push(`工作区检索 ${sources.length} 条`);
        }
        const user: ChatMessage = {
          id: newId(),
          role: "user",
          text: expanded,
          contextBlock,
          contextLabels: labels,
          sources,
          timestamp: Date.now(),
        };
        await respond([...get().messages, user]);
      } catch (error) {
        set({ error: errorText(error), draft: rawText });
      }
    },

    stop: async () => {
      if (currentRequest) {
        await currentRequest.cancel();
      }
    },

    regenerate: async (assistantId) => {
      if (get().streamingId) {
        return;
      }
      const index = get().messages.findIndex((message) => message.id === assistantId);
      if (index <= 0) {
        return;
      }
      await respond(get().messages.slice(0, index));
    },

    editUserMessage: async (id, text) => {
      if (get().streamingId || !text.trim()) {
        return;
      }
      const index = get().messages.findIndex((message) => message.id === id);
      if (index < 0) {
        return;
      }
      // 编辑后沿用原消息的上下文，丢弃其后的对话并重新生成。
      const edited = { ...get().messages[index], text: text.trim(), timestamp: Date.now() };
      await respond([...get().messages.slice(0, index), edited]);
    },

    deleteMessage: (id) => {
      if (get().streamingId === id) {
        return;
      }
      set({ messages: get().messages.filter((message) => message.id !== id) });
      void autosave();
    },

    newChat: () => {
      if (get().streamingId) {
        return;
      }
      set({ messages: [], conversationPath: null, attachments: [], activeNoteDetached: false, error: "" });
    },

    openConversation: async (path) => {
      if (get().streamingId) {
        return;
      }
      try {
        const saved = await loadConversation(path);
        const messages: ChatMessage[] = saved.map((message) => ({
          id: newId(),
          role: message.role,
          text: message.content,
          contextBlock: "",
          contextLabels: [],
          sources: [],
          timestamp: message.timestamp,
        }));
        set({ messages, conversationPath: path, error: "" });
      } catch (error) {
        set({ error: errorText(error) });
      }
    },
  };
});

/**
 * 保存当前对话：首条消息时生成文件名，之后覆盖同一文件。
 * 自动保存在每次回答结束后调用；关闭自动保存时由「保存对话」按钮调用。
 */
export async function saveCurrentConversation(): Promise<string | null> {
  const state = useCopilot.getState();
  if (state.messages.length === 0) {
    return null;
  }
  let path = state.conversationPath;
  if (!path) {
    path = newConversationPath(state.messages[0].text, state.messages[0].timestamp);
    if (!path) {
      return null;
    }
    useCopilot.setState({ conversationPath: path });
  }
  const saved = state.messages
    .filter((message) => !message.error)
    .map((message) => ({ role: message.role, content: message.text, timestamp: message.timestamp }));
  await saveConversation(path, saved, state.modelLabel);
  return path;
}
