/**
 * Copilot 设置：常规选项、系统提示词和命令管理，对应 Obsidian Copilot 的 Basic 与 Command 分页。
 */

import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { errorText } from "../../backend";
import type { SendShortcut } from "../../settings/schema";
import { useSettings } from "../../settings/settingsStore";
import { useAppStore } from "../../store";
import { iconSize } from "../../styles/tokens";
import { DEFAULT_SYSTEM_PROMPT } from "../copilot/context";
import { useCopilot } from "../copilot/copilotStore";
import { COMMANDS_FOLDER, deleteCommand, generateDefaultCommands, saveCommand, type CustomCommand } from "../copilot/customCommands";
import { CONVERSATIONS_FOLDER } from "../copilot/history";
import { SettingHeading, SettingItem, Toggle } from "./SettingsModal";

function CommandEditor({ command, onDone }: { command: CustomCommand | null; onDone: (message: string) => void }) {
  const commands = useCopilot((state) => state.commands);
  const reloadCommands = useCopilot((state) => state.reloadCommands);
  const [name, setName] = useState(command?.name ?? "");
  const [prompt, setPrompt] = useState(command?.prompt ?? "");
  const [contextMenu, setContextMenu] = useState(command?.showInContextMenu ?? true);
  const [slash, setSlash] = useState(command?.showInSlashMenu ?? true);
  const [error, setError] = useState("");

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed || !prompt.trim()) {
      setError("请填写命令名称和提示词。");
      return;
    }
    const duplicate = commands.some((item) => item.name === trimmed && item.name !== command?.name);
    if (duplicate) {
      setError("已有同名命令。");
      return;
    }
    const order = command?.order ?? (commands.length + 1) * 10;
    try {
      await saveCommand({ name: trimmed, prompt, showInContextMenu: contextMenu, showInSlashMenu: slash, order }, command?.name);
      await reloadCommands();
      onDone(`已保存命令「${trimmed}」。`);
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  return (
    <div className="dc-command-editor">
      <input className="dc-input" placeholder="命令名称" value={name} onChange={(event) => setName(event.target.value)} />
      <textarea
        className="dc-input dc-textarea"
        placeholder="提示词。{} 代表选区（无选区时为当前笔记），{activeNote} 代表当前笔记，{[[笔记标题]]} 代表指定笔记。"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />
      <label className="dc-check">
        <input type="checkbox" checked={contextMenu} onChange={(event) => setContextMenu(event.target.checked)} />
        显示在右键菜单
      </label>
      <label className="dc-check">
        <input type="checkbox" checked={slash} onChange={(event) => setSlash(event.target.checked)} />
        显示在 / 菜单
      </label>
      {error && <p className="dc-status-line is-error">{error}</p>}
      <div className="dc-row-actions">
        <button type="button" className="dc-button" onClick={() => onDone("")}>
          取消
        </button>
        <button type="button" className="dc-button is-primary" onClick={() => void handleSave()}>
          保存
        </button>
      </div>
    </div>
  );
}

function CommandList() {
  const workspace = useAppStore((state) => state.workspace);
  const commands = useCopilot((state) => state.commands);
  const reloadCommands = useCopilot((state) => state.reloadCommands);
  const [editing, setEditing] = useState<CustomCommand | "new" | null>(null);
  const [message, setMessage] = useState("");

  if (!workspace) {
    return <p className="dc-setting-note">命令保存在工作区内，打开工作区后可管理。</p>;
  }

  const handleGenerate = async () => {
    try {
      const added = await generateDefaultCommands(commands);
      await reloadCommands();
      setMessage(added > 0 ? `已添加 ${added} 个默认命令。` : "默认命令都已存在。");
    } catch (error) {
      setMessage(errorText(error));
    }
  };

  const handleDelete = async (command: CustomCommand) => {
    const confirmed = await ask(`删除命令「${command.name}」？对应的 Markdown 文件会被永久删除，无法恢复。`, {
      title: "删除命令",
      kind: "warning",
      okLabel: "删除",
      cancelLabel: "取消",
    });
    if (!confirmed) {
      return;
    }
    try {
      await deleteCommand(command.name);
      await reloadCommands();
    } catch (error) {
      setMessage(errorText(error));
    }
  };

  return (
    <>
      <div className="dc-row-actions is-start">
        <button type="button" className="dc-button is-primary" onClick={() => setEditing("new")}>
          <Plus size={iconSize.sm} />
          添加命令
        </button>
        <button type="button" className="dc-button" onClick={() => void handleGenerate()}>
          生成默认命令
        </button>
      </div>
      {message && <p className="dc-status-line">{message}</p>}
      {editing === "new" && (
        <CommandEditor
          command={null}
          onDone={(text) => {
            setEditing(null);
            setMessage(text);
          }}
        />
      )}
      {commands.length === 0 && editing !== "new" && <p className="dc-setting-note">还没有命令。可以点击「生成默认命令」。</p>}
      <ul className="dc-command-list">
        {commands.map((command) =>
          editing !== "new" && editing?.name === command.name ? (
            <li key={command.name}>
              <CommandEditor
                command={command}
                onDone={(text) => {
                  setEditing(null);
                  setMessage(text);
                }}
              />
            </li>
          ) : (
            <li key={command.name} className="dc-command-row">
              <div className="dc-setting-info">
                <div className="dc-setting-name">{command.name}</div>
                <div className="dc-setting-description">
                  {[command.showInContextMenu ? "右键菜单" : "", command.showInSlashMenu ? "/ 菜单" : ""].filter(Boolean).join(" · ") || "仅命令面板"}
                </div>
              </div>
              <button type="button" className="dc-icon-button" aria-label={`编辑命令${command.name}`} title="编辑" onClick={() => setEditing(command)}>
                <Pencil size={iconSize.sm} />
              </button>
              <button type="button" className="dc-icon-button" aria-label={`删除命令${command.name}`} title="删除" onClick={() => void handleDelete(command)}>
                <Trash2 size={iconSize.sm} />
              </button>
            </li>
          ),
        )}
      </ul>
    </>
  );
}

export function CopilotSettings() {
  const copilot = useSettings((state) => state.settings.copilot);
  const update = useSettings((state) => state.update);
  const reloadCommands = useCopilot((state) => state.reloadCommands);
  const [folderDraft, setFolderDraft] = useState(copilot.folder);

  const commitFolder = () => {
    const folder = folderDraft.trim().replace(/^[\\/]+|[\\/]+$/g, "");
    if (!folder || folder.includes("..")) {
      setFolderDraft(copilot.folder);
      return;
    }
    update("copilot", { folder });
    void reloadCommands();
  };

  return (
    <>
      <SettingHeading>常规</SettingHeading>
      <SettingItem
        name="Copilot 文件夹"
        description={`工作区内的相对路径。对话记录保存在其下的 ${CONVERSATIONS_FOLDER}/，命令保存在 ${COMMANDS_FOLDER}/，格式与 Obsidian Copilot 相同。`}
      >
        <input className="dc-input" value={folderDraft} onChange={(event) => setFolderDraft(event.target.value)} onBlur={commitFolder} onKeyDown={(event) => event.key === "Enter" && commitFolder()} />
      </SettingItem>
      <SettingItem name="自动附带当前笔记" description="新对话默认把正在编辑的笔记作为上下文，可在输入区移除。">
        <Toggle label="自动附带当前笔记" checked={copilot.autoAttachActiveNote} onChange={(value) => update("copilot", { autoAttachActiveNote: value })} />
      </SettingItem>
      <SettingItem name="自动保存对话" description="每次回答后把对话保存为 Markdown；关闭后可在 Copilot 顶栏手动保存。">
        <Toggle label="自动保存对话" checked={copilot.autosave} onChange={(value) => update("copilot", { autosave: value })} />
      </SettingItem>
      <SettingItem name="发送快捷键">
        <select className="dc-input" value={copilot.sendShortcut} onChange={(event) => update("copilot", { sendShortcut: event.target.value as SendShortcut })}>
          <option value="enter">Enter 发送，Shift+Enter 换行</option>
          <option value="shift-enter">Shift+Enter 发送，Enter 换行</option>
        </select>
      </SettingItem>
      <SettingItem name="系统提示词" description={<details><summary>默认提示词</summary><pre className="dc-setting-pre">{DEFAULT_SYSTEM_PROMPT}</pre></details>} />
      <textarea
        className="dc-input dc-textarea"
        placeholder="在默认提示词之后追加的要求，例如：回答使用正式书面语。"
        value={copilot.systemPrompt}
        onChange={(event) => update("copilot", { systemPrompt: event.target.value })}
      />
      <SettingHeading>命令</SettingHeading>
      <p className="dc-setting-note">在对话中输入 / 使用命令，或在编辑区右键 → Copilot 对选区运行。</p>
      <CommandList />
    </>
  );
}
