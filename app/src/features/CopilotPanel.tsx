/**
 * Copilot：工作区整理。
 *
 * 流程分两步，用户可在外发前审阅：先在本地检索工作区 Markdown 得到摘录，用户勾选确认后，
 * 只把选中的摘录和问题发给所选 AI 服务。整理稿的来源可跳回对应文件。
 */

import { useState } from "react";
import { ArrowUpRight, ClipboardCopy, FileInput, Search, Send } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { docflow, errorText } from "../backend";
import { openDocument } from "../documentActions";
import { insertMarkdown, revealText } from "../editor/editorHandle";
import { useAppStore } from "../store";
import { StatusLine } from "../components/Dialog";
import { iconSize } from "../styles/tokens";
import { aiDestination, loadAiStatus } from "./aiSettings";

interface Source {
  id: number;
  path: string;
  line: number;
  excerpt: string;
}

interface Answer {
  answer: string;
  sources: Source[];
}

function joinWorkspacePath(workspace: string, relative: string): string {
  const separator = workspace.endsWith("\\") ? "" : "\\";
  return `${workspace}${separator}${relative.replaceAll("/", "\\")}`;
}

export function CopilotPanel() {
  const workspace = useAppStore((state) => state.workspace);
  const apiKey = useAppStore((state) => state.apiKey);
  const [question, setQuestion] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [searchedQuestion, setSearchedQuestion] = useState("");

  if (!workspace) {
    return <div className="dc-sidebar-empty">打开工作区后，Copilot 可检索并整理其中的 Markdown。</div>;
  }

  const handleSearch = async () => {
    const query = question.trim();
    if (!query) {
      return;
    }
    setBusy(true);
    setMessage("");
    setAnswer(null);
    try {
      const result = await docflow<{ sources: Source[] }>(["assistant", "search", "--workspace", workspace, "--question", query]);
      setSources(result.sources);
      setSelected(new Set(result.sources.map((source) => source.id)));
      setSearchedQuestion(query);
      if (result.sources.length === 0) {
        setMessage("没有检索到相关摘录，换个说法试试。");
      }
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const handleOrganize = async () => {
    const chosen = sources.filter((source) => selected.has(source.id));
    if (chosen.length === 0) {
      setMessage("请至少保留一条摘录。");
      return;
    }
    const status = await loadAiStatus();
    const destination = aiDestination(status);
    const confirmed = await ask(`将问题和选中的 ${chosen.length} 条摘录发送到 ${destination} 进行整理。继续吗？`, {
      title: "提交给 AI",
      kind: "info",
      okLabel: "发送",
      cancelLabel: "取消",
    });
    if (!confirmed) {
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result = await docflow<Answer>(
        ["assistant", "organize", "--workspace", workspace, "--question", searchedQuestion],
        { input: { sources: chosen }, apiKey },
      );
      setAnswer(result);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const toggleSource = (id: number) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleJump = async (source: Source) => {
    const opened = await openDocument(joinWorkspacePath(workspace, source.path));
    if (!opened) {
      return;
    }
    const firstLine = source.excerpt.split("\n")[0] ?? "";
    // 摘录取自 Markdown 原文，去掉行首的标题、列表和引用标记后在正文中查找。
    const probe = firstLine.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "").slice(0, 40);
    window.setTimeout(() => revealText(probe), 0);
  };

  return (
    <div className="dc-panel-content">
      <div className="dc-copilot-ask">
        <textarea
          className="dc-input dc-textarea"
          placeholder="向工作区提问，例如：汇总各篇报告中的流量试验结论"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void handleSearch();
            }
          }}
        />
        <button type="button" className="dc-button is-primary" disabled={busy || !question.trim()} onClick={() => void handleSearch()}>
          <Search size={iconSize.sm} />
          本地检索
        </button>
      </div>
      <StatusLine text={busy ? "处理中…" : message} tone={message && !busy ? "error" : "normal"} />

      {sources.length > 0 && !answer && (
        <section className="dc-copilot-section">
          <h3 className="dc-section-title">确认要发送的摘录</h3>
          <ul className="dc-source-list">
            {sources.map((source) => (
              <li key={source.id} className="dc-source">
                <label className="dc-source-check">
                  <input type="checkbox" checked={selected.has(source.id)} onChange={() => toggleSource(source.id)} />
                  <span className="dc-source-path">
                    [{source.id}] {source.path}:{source.line}
                  </span>
                </label>
                <p className="dc-source-excerpt">{source.excerpt}</p>
              </li>
            ))}
          </ul>
          <button type="button" className="dc-button is-primary" disabled={busy} onClick={() => void handleOrganize()}>
            <Send size={iconSize.sm} />
            提交给 AI 整理
          </button>
        </section>
      )}

      {answer && (
        <section className="dc-copilot-section">
          <h3 className="dc-section-title">整理稿</h3>
          <div className="dc-answer">{answer.answer}</div>
          <div className="dc-row-actions">
            <button type="button" className="dc-button" onClick={() => void navigator.clipboard.writeText(answer.answer)}>
              <ClipboardCopy size={iconSize.sm} />
              复制
            </button>
            <button type="button" className="dc-button" onClick={() => insertMarkdown(answer.answer)}>
              <FileInput size={iconSize.sm} />
              插入到光标处
            </button>
          </div>
          <h3 className="dc-section-title">来源</h3>
          <ul className="dc-source-list">
            {answer.sources.map((source) => (
              <li key={source.id} className="dc-source">
                <button type="button" className="dc-link-button" onClick={() => void handleJump(source)}>
                  [{source.id}] {source.path}:{source.line}
                  <ArrowUpRight size={iconSize.sm} />
                </button>
                <p className="dc-source-excerpt">{source.excerpt}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
