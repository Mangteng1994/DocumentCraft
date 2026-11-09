/**
 * Copilot 命令（自定义提示词）。
 *
 * 与 Obsidian Copilot 相同，每个命令是 `<工作区>/<Copilot 文件夹>/copilot-custom-prompts/` 下的一个
 * Markdown 文件：文件名即命令名，正文即提示词，frontmatter 使用 copilot-command-* 字段。
 * 同一工作区可以直接与 Obsidian Copilot 共用这些文件。
 *
 * 提示词模板变量：{} 选区（无选区时为当前笔记）、{activeNote} 当前笔记、{[[笔记标题]]} 指定笔记。
 */

import { createDir, listTree, readText, removeMarkdown, writeText } from "../../backend";
import { joinPath, safeFileName } from "../../paths";
import { getSettings } from "../../settings/settingsStore";
import { useAppStore } from "../../store";
import { findNoteByTitle, readNote } from "./context";

export const COMMANDS_FOLDER = "copilot-custom-prompts";

export interface CustomCommand {
  name: string;
  prompt: string;
  showInContextMenu: boolean;
  showInSlashMenu: boolean;
  order: number;
}

const KEY_CONTEXT_MENU = "copilot-command-context-menu-enabled";
const KEY_SLASH = "copilot-command-slash-enabled";
const KEY_ORDER = "copilot-command-context-menu-order";

/** Generate defaults 生成的初始命令，对应 Obsidian Copilot 的默认命令并补充科研写作常用项。 */
export const DEFAULT_COMMANDS: Omit<CustomCommand, "order">[] = [
  { name: "修正语法和错别字", prompt: "修正 {} 中的语法和错别字。保留全部格式、换行和特殊字符，不增删内容。只返回修正后的文本。", showInContextMenu: true, showInSlashMenu: true },
  { name: "翻译成中文", prompt: "把 {} 翻译成中文，术语保持准确，保留 Markdown 格式。只返回译文。", showInContextMenu: true, showInSlashMenu: true },
  { name: "翻译成英文", prompt: "把 {} 翻译成学术英语，术语保持准确，保留 Markdown 格式。只返回译文。", showInContextMenu: true, showInSlashMenu: true },
  { name: "总结要点", prompt: "用要点列表总结 {}，每条概括一个关键点。只返回要点列表。", showInContextMenu: true, showInSlashMenu: true },
  { name: "学术化润色", prompt: "把 {} 润色为规范的中文科研报告表述：用词准确、句式简洁、逻辑连贯，不改变原意和数据。只返回润色后的文本。", showInContextMenu: true, showInSlashMenu: true },
  { name: "简化表述", prompt: "用更简单直白的语言改写 {}，保留关键概念。只返回改写后的文本。", showInContextMenu: true, showInSlashMenu: true },
  { name: "缩短篇幅", prompt: "把 {} 压缩到约一半篇幅，保留核心信息、数据和结论。只返回压缩后的文本。", showInContextMenu: true, showInSlashMenu: true },
  { name: "扩写", prompt: "把 {} 扩写到约两倍篇幅：补充解释、过渡和必要细节，不编造数据。只返回扩写后的文本。", showInContextMenu: true, showInSlashMenu: true },
  { name: "生成目录", prompt: "为 {} 生成层级目录，使用合适的标题层级。只返回目录。", showInContextMenu: false, showInSlashMenu: true },
  { name: "生成术语表", prompt: "从 {} 中整理重要术语，格式为「术语：释义」，按拼音或字母排序。只返回术语表。", showInContextMenu: false, showInSlashMenu: true },
  { name: "移除链接", prompt: "移除 {} 中的所有网址，保留其他内容和格式。只返回处理后的文本。", showInContextMenu: false, showInSlashMenu: true },
];

export function commandsFolder(): string | null {
  const { workspace } = useAppStore.getState();
  if (!workspace) {
    return null;
  }
  return joinPath(workspace, getSettings().copilot.folder, COMMANDS_FOLDER);
}

function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const normalized = text.replace(/\r\n?/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return { fields: {}, body: normalized };
  }
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
      fields[key] = value;
    }
  }
  return { fields, body: normalized.slice(match[0].length) };
}

function serializeCommand(command: CustomCommand): string {
  const lines = [
    "---",
    `${KEY_CONTEXT_MENU}: ${command.showInContextMenu}`,
    `${KEY_SLASH}: ${command.showInSlashMenu}`,
    `${KEY_ORDER}: ${command.order}`,
    "---",
    command.prompt.trim(),
    "",
  ];
  return lines.join("\n");
}

export async function loadCommands(): Promise<CustomCommand[]> {
  const folder = commandsFolder();
  if (!folder) {
    return [];
  }
  let entries;
  try {
    entries = await listTree(folder);
  } catch {
    // 文件夹不存在时视为没有命令。
    return [];
  }
  const commands: CustomCommand[] = [];
  for (const entry of entries.children) {
    if (entry.is_dir) {
      continue;
    }
    const text = await readText(entry.path);
    const { fields, body } = parseFrontmatter(text);
    const order = Number(fields[KEY_ORDER]);
    commands.push({
      name: entry.name.replace(/\.(md|markdown)$/i, ""),
      prompt: body.trim(),
      showInContextMenu: fields[KEY_CONTEXT_MENU] !== "false",
      showInSlashMenu: fields[KEY_SLASH] !== "false",
      order: Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER,
    });
  }
  commands.sort((left, right) => left.order - right.order || left.name.localeCompare(right.name, "zh-CN"));
  return commands;
}

function commandPath(folder: string, name: string): string {
  return joinPath(folder, `${safeFileName(name, 80)}.md`);
}

/** 保存命令；改名时删除旧文件。 */
export async function saveCommand(command: CustomCommand, previousName?: string): Promise<void> {
  const folder = commandsFolder();
  if (!folder) {
    throw new Error("请先打开工作区。");
  }
  await createDir(folder);
  await writeText(commandPath(folder, command.name), serializeCommand(command));
  if (previousName && safeFileName(previousName, 80) !== safeFileName(command.name, 80)) {
    await removeMarkdown(commandPath(folder, previousName));
  }
}

export async function deleteCommand(name: string): Promise<void> {
  const folder = commandsFolder();
  if (!folder) {
    return;
  }
  await removeMarkdown(commandPath(folder, name));
}

/** 写入尚不存在的默认命令，不覆盖用户已改过的同名命令。 */
export async function generateDefaultCommands(existing: CustomCommand[]): Promise<number> {
  const names = new Set(existing.map((command) => command.name));
  let added = 0;
  for (const [index, command] of DEFAULT_COMMANDS.entries()) {
    if (names.has(command.name)) {
      continue;
    }
    await saveCommand({ ...command, order: (index + 1) * 10 });
    added += 1;
  }
  return added;
}

export interface TemplateInput {
  selection: string | null;
  activeNotePath: string | null;
}

/** 展开提示词中的模板变量。 */
export async function renderPrompt(prompt: string, input: TemplateInput): Promise<string> {
  const activeNote = input.activeNotePath ? await readNote(input.activeNotePath) : "";
  let result = prompt;
  const noteMatches = [...result.matchAll(/\{\[\[([^\]]+)\]\]\}/g)];
  for (const match of noteMatches) {
    const path = findNoteByTitle(match[1]);
    const content = path ? await readNote(path) : `（未找到笔记：${match[1]}）`;
    result = result.replace(match[0], `\n\n${content}\n\n`);
  }
  result = result.replaceAll("{activeNote}", activeNote);
  const target = input.selection ?? activeNote;
  result = result.replaceAll("{}", target);
  return result;
}
