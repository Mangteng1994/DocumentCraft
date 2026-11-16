/**
 * 文件：目录树显示范围与五彩文档大纲。
 */

import { refreshTree } from "../../documentActions";
import { useSettings } from "../../settings/settingsStore";
import { ColorfulOutlineSettings } from "./ColorfulOutlineSettings";
import { SettingItem, Toggle } from "./SettingsModal";

export function FilesSettings() {
  const showAllFiles = useSettings((state) => state.settings.files.showAllFiles);
  const update = useSettings((state) => state.update);

  const handleChange = (value: boolean) => {
    update("files", { showAllFiles: value });
    // 设置已同步写入状态，刷新目录树会按新的显示范围重新读取。
    void refreshTree();
  };

  return (
    <>
      <SettingItem
        name="显示所有文件"
        description="关闭时目录树只显示 Markdown 文件和含 Markdown 的文件夹。开启后列出工作区内的全部文件和空文件夹（隐藏文件夹除外）；非 Markdown 文件置灰显示，点击用系统默认应用打开（程序和脚本不会直接运行）。"
      >
        <Toggle label="显示所有文件" checked={showAllFiles} onChange={handleChange} />
      </SettingItem>
      <ColorfulOutlineSettings />
    </>
  );
}
