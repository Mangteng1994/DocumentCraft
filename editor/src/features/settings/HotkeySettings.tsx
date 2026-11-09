/**
 * 快捷键设置：点击录制框后按下新组合键即可绑定，Backspace 清除，Esc 取消录制。
 * 与其他操作冲突时提示，确认后把冲突操作的快捷键清空。
 */

import { useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { actionLabel, eventToHotkey, findConflict, isAssignable } from "../../settings/hotkeys";
import { ACTIONS, DEFAULT_SETTINGS, type ActionId } from "../../settings/schema";
import { useSettings } from "../../settings/settingsStore";
import { iconSize } from "../../styles/tokens";
import { SettingHeading, SettingItem } from "./SettingsModal";

function HotkeyRecorder({ actionId }: { actionId: ActionId }) {
  const hotkeys = useSettings((state) => state.settings.hotkeys);
  const update = useSettings((state) => state.update);
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState("");
  const value = hotkeys[actionId];

  const assign = (hotkey: string) => {
    const conflict = findConflict(hotkeys, actionId, hotkey);
    const patch: Partial<Record<ActionId, string>> = { [actionId]: hotkey };
    if (conflict) {
      patch[conflict] = "";
      setNotice(`已从「${actionLabel(conflict)}」移除 ${hotkey}`);
    } else {
      setNotice("");
    }
    update("hotkeys", patch);
    setRecording(false);
  };

  return (
    <div className="dc-hotkey">
      <button
        type="button"
        data-hotkey-recorder
        className={`dc-hotkey-recorder${recording ? " is-recording" : ""}`}
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(event) => {
          if (!recording) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape") {
            setRecording(false);
            return;
          }
          if (event.key === "Backspace" && !event.ctrlKey && !event.altKey) {
            assign("");
            return;
          }
          const hotkey = eventToHotkey(event.nativeEvent);
          if (!hotkey) {
            return;
          }
          if (!isAssignable(hotkey)) {
            setNotice("请包含 Ctrl 或 Alt，或使用 F1–F12。");
            return;
          }
          assign(hotkey);
        }}
      >
        {recording ? "按下快捷键…" : value || "未设置"}
      </button>
      <button type="button" className="dc-icon-button" title="清除" aria-label={`清除${actionLabel(actionId)}的快捷键`} disabled={!value} onClick={() => assign("")}>
        <X size={iconSize.sm} />
      </button>
      <button
        type="button"
        className="dc-icon-button"
        title="恢复默认"
        aria-label={`恢复${actionLabel(actionId)}的默认快捷键`}
        disabled={value === DEFAULT_SETTINGS.hotkeys[actionId]}
        onClick={() => assign(DEFAULT_SETTINGS.hotkeys[actionId])}
      >
        <RotateCcw size={iconSize.sm} />
      </button>
      {notice && <span className="dc-hotkey-notice">{notice}</span>}
    </div>
  );
}

export function HotkeySettings() {
  const replaceSection = useSettings((state) => state.replaceSection);
  const editorActions = ACTIONS.filter((action) => action.scope === "editor");
  const globalActions = ACTIONS.filter((action) => action.scope === "global");
  return (
    <>
      <SettingItem name="恢复全部默认快捷键" description="标题 Ctrl+1～6，正文段落 Ctrl+0，插入表格 Ctrl+T。">
        <button type="button" className="dc-button" onClick={() => replaceSection("hotkeys", { ...DEFAULT_SETTINGS.hotkeys })}>
          全部恢复
        </button>
      </SettingItem>
      <SettingHeading>编辑区</SettingHeading>
      <p className="dc-setting-note">只在编辑区获得焦点时生效。Markdown 只有 1～6 级标题。</p>
      {editorActions.map((action) => (
        <SettingItem key={action.id} name={action.label}>
          <HotkeyRecorder actionId={action.id} />
        </SettingItem>
      ))}
      <SettingHeading>全局</SettingHeading>
      {globalActions.map((action) => (
        <SettingItem key={action.id} name={action.label}>
          <HotkeyRecorder actionId={action.id} />
        </SettingItem>
      ))}
    </>
  );
}
