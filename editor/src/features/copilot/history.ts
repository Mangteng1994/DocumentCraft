/**
 * Copilot 对话记录。
 *
 * 与 Obsidian Copilot 的保存格式一致：`<工作区>/<Copilot 文件夹>/copilot-conversations/` 下每个对话一个
 * Markdown 文件，frontmatter 记录 epoch 与 copilot-conversation 标签，正文按「**user**: / **ai**:」
 * 加 [Timestamp: …] 记录每条消息。只保存用户原话与回答，不保存附带的上下文全文。
 */

import { createDir, listTree, readText, removeMarkdown, writeText } from "../../backend";
import { joinPath, safeFileName } from "../../paths";
import { getSettings } from "../../settings/settingsStore";
import { useAppStore } from "../../store";

export const CONVERSATIONS_FOLDER = "copilot-conversations";

export interface SavedMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface ConversationFile {
  path: string;
  title: string;
}

export function conversationsFolder(): string | null {
  const { workspace } = useAppStore.getState();
  if (!workspace) {
    return null;
  }
  return joinPath(workspace, getSettings().copilot.folder, CONVERSATIONS_FOLDER);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function displayTime(epoch: number): string {
  const date = new Date(epoch);
  const day = `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${day} ${time}`;
}

function fileStamp(epoch: number): string {
  const date = new Date(epoch);
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${day}_${time}`;
}

/** 新对话的文件路径：首条消息前若干字 + 时间戳。 */
export function newConversationPath(firstMessage: string, epoch: number): string | null {
  const folder = conversationsFolder();
  if (!folder) {
    return null;
  }
  const title = safeFileName(firstMessage.replace(/\s+/g, " "), 30);
  return joinPath(folder, `${title}@${fileStamp(epoch)}.md`);
}

export function serializeConversation(messages: SavedMessage[], model: string): string {
  const epoch = messages[0]?.timestamp ?? Date.now();
  const lines = ["---", `epoch: ${epoch}`, `modelKey: ${JSON.stringify(model)}`, "tags:", "  - copilot-conversation", "---", ""];
  for (const message of messages) {
    const sender = message.role === "user" ? "user" : "ai";
    lines.push(`**${sender}**: ${message.content}`);
    lines.push(`[Timestamp: ${displayTime(message.timestamp)}]`);
    lines.push("");
  }
  return lines.join("\n");
}

export async function saveConversation(path: string, messages: SavedMessage[], model: string): Promise<void> {
  const folder = conversationsFolder();
  if (folder) {
    await createDir(folder);
  }
  await writeText(path, serializeConversation(messages, model));
}

function parseTimestamp(value: string, fallback: number): number {
  const match = value.match(/(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!match) {
    return fallback;
  }
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

/** 解析保存的对话。消息正文可以跨多行，直到下一条 [Timestamp: …]。 */
export function parseConversation(text: string): SavedMessage[] {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/^---\n[\s\S]*?\n---\n?/, "");
  const messages: SavedMessage[] = [];
  let current: SavedMessage | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current) {
      current.content = buffer.join("\n").trim();
      messages.push(current);
    }
    current = null;
    buffer = [];
  };
  for (const line of normalized.split("\n")) {
    const header = line.match(/^\*\*(user|ai)\*\*: ?(.*)$/);
    if (header && !current) {
      current = { role: header[1] === "user" ? "user" : "assistant", content: "", timestamp: Date.now() };
      buffer = [header[2]];
      continue;
    }
    const stamp = line.match(/^\[Timestamp: (.*)\]$/);
    if (stamp && current) {
      current.timestamp = parseTimestamp(stamp[1], current.timestamp);
      flush();
      continue;
    }
    if (current) {
      buffer.push(line);
    }
  }
  flush();
  return messages;
}

export async function listConversations(): Promise<ConversationFile[]> {
  const folder = conversationsFolder();
  if (!folder) {
    return [];
  }
  try {
    const tree = await listTree(folder);
    const files = tree.children.filter((entry) => !entry.is_dir);
    // 文件名带 @时间戳，倒序即最新在前。
    files.sort((left, right) => right.name.localeCompare(left.name));
    return files.map((entry) => ({ path: entry.path, title: entry.name.replace(/\.md$/i, "") }));
  } catch {
    return [];
  }
}

export async function loadConversation(path: string): Promise<SavedMessage[]> {
  const text = await readText(path);
  return parseConversation(text);
}

export function deleteConversation(path: string): Promise<void> {
  return removeMarkdown(path);
}
