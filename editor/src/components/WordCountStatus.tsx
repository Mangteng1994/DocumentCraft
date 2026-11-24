/** 窗口右下角的正文与选区字数，只订阅统计所需状态，避免拖选时重绘整个工作台。 */
import { useAppStore } from "../store";

export function WordCountStatus() {
  const filePath = useAppStore((state) => state.filePath);
  const total = useAppStore((state) => state.documentCharCount);
  const selected = useAppStore((state) => state.selectionCharCount);
  if (!filePath) {
    return null;
  }
  return (
    <span
      className="dc-statusbar-word-count"
      title="按正文非空白字符计数（含标点）；不计格式标记、图片、公式和文档元数据"
      aria-label={`全文 ${total} 字，选中 ${selected} 字`}
    >
      <span>字数 {total.toLocaleString()}</span>
      <span>选中 {selected.toLocaleString()}</span>
    </span>
  );
}
