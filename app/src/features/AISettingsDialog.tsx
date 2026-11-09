/**
 * AI 设置：兼容 API 或 ChatGPT 套餐。
 *
 * API Key 只存于本次会话内存，调用时经环境变量传给 docflow；也可由 OPENAI_API_KEY 提供。
 * ChatGPT 登录在系统浏览器完成，等待期间可取消（结束 docflow 进程）。
 */

import { useEffect, useMemo, useState } from "react";
import { cancelDocflow, docflow, errorText, newJobId } from "../backend";
import { useAppStore } from "../store";
import { Dialog, Field, StatusLine } from "../components/Dialog";
import { EFFORT_LABELS, loadAiStatus, type AiStatus, type ChatGPTModel, type Provider } from "./aiSettings";

export function AISettingsDialog() {
  const setDialog = useAppStore((state) => state.setDialog);
  const apiKey = useAppStore((state) => state.apiKey);
  const setApiKey = useAppStore((state) => state.setApiKey);

  const [status, setStatus] = useState<AiStatus | null>(null);
  const [provider, setProvider] = useState<Provider>("api");
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [keyDraft, setKeyDraft] = useState(apiKey);
  const [models, setModels] = useState<ChatGPTModel[]>([]);
  const [chatgptModel, setChatgptModel] = useState("");
  const [effort, setEffort] = useState("");
  const [loginJob, setLoginJob] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [tone, setTone] = useState<"normal" | "error">("normal");

  const report = (text: string, nextTone: "normal" | "error" = "normal") => {
    setMessage(text);
    setTone(nextTone);
  };

  const refreshModels = async () => {
    setBusy(true);
    report("正在读取账号可用的模型…");
    try {
      const result = await docflow<{ models: ChatGPTModel[] }>(["ai", "models"]);
      setModels(result.models);
      // 按 slug 恢复已保存的模型，账号目录里没有时回退到第一个可用模型。
      setChatgptModel((previous) => {
        const known = result.models.some((item) => item.slug === previous);
        if (known) {
          return previous;
        }
        return result.models[0]?.slug ?? "";
      });
      report(result.models.length > 0 ? "分析使用当前账号的 ChatGPT 套餐额度。" : "当前账号暂无可用模型。");
    } catch (error) {
      report(errorText(error), "error");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    loadAiStatus()
      .then((loaded) => {
        if (cancelled) {
          return;
        }
        setStatus(loaded);
        setProvider(loaded.provider);
        setEndpoint(loaded.endpoint);
        setModel(loaded.model);
        setChatgptModel(loaded.chatgpt_model);
        setEffort(loaded.chatgpt_effort);
      })
      .catch((error) => report(errorText(error), "error"));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (provider === "chatgpt" && status?.account && models.length === 0) {
      void refreshModels();
    }
    // 仅在切换到 ChatGPT 或登录状态变化时自动读取模型。
  }, [provider, status?.account]);

  const selectedModel = useMemo(() => models.find((item) => item.slug === chatgptModel), [models, chatgptModel]);
  const effortChoices = selectedModel ? ["", ...selectedModel.efforts] : [""];

  const handleLogin = async () => {
    const job = newJobId("login");
    setLoginJob(job);
    report("请在浏览器完成授权，再返回 DocumentCraft。");
    try {
      const result = await docflow<{ account: string }>(["ai", "login"], { job });
      setStatus((previous) => (previous ? { ...previous, account: result.account } : previous));
      report(`已登录 ${result.account}。`);
    } catch (error) {
      report(errorText(error), "error");
    } finally {
      setLoginJob(null);
    }
  };

  const handleCancelLogin = async () => {
    if (loginJob) {
      await cancelDocflow(loginJob);
    }
  };

  const handleLogout = async () => {
    setBusy(true);
    try {
      await docflow(["ai", "logout"]);
      setStatus((previous) => (previous ? { ...previous, account: null } : previous));
      setModels([]);
      report("已退出 DocumentCraft 的 ChatGPT 会话。");
    } catch (error) {
      report(errorText(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async () => {
    setBusy(true);
    try {
      const payload = {
        provider,
        endpoint,
        model,
        chatgpt_model: chatgptModel,
        chatgpt_effort: effortChoices.includes(effort) ? effort : "",
      };
      await docflow(["ai", "save"], { input: payload });
      setApiKey(keyDraft.trim());
      report("设置已保存。");
    } catch (error) {
      report(errorText(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const waiting = loginJob !== null;
  const footer = (
    <>
      <button type="button" className="dc-button" onClick={() => setDialog(null)} disabled={waiting}>
        关闭
      </button>
      <button type="button" className="dc-button is-primary" onClick={() => void handleSave()} disabled={busy || waiting}>
        保存设置
      </button>
    </>
  );

  return (
    <Dialog title="AI 设置" onClose={() => setDialog(null)} footer={footer} busy={waiting}>
      <div className="dc-segmented" role="radiogroup" aria-label="连接方式">
        <button type="button" role="radio" aria-checked={provider === "api"} className={`dc-segment${provider === "api" ? " is-selected" : ""}`} onClick={() => setProvider("api")}>
          兼容 API
        </button>
        <button type="button" role="radio" aria-checked={provider === "chatgpt"} className={`dc-segment${provider === "chatgpt" ? " is-selected" : ""}`} onClick={() => setProvider("chatgpt")}>
          ChatGPT 套餐
        </button>
      </div>

      {provider === "api" ? (
        <>
          <Field label="接口地址" hint="兼容 /chat/completions 且支持 JSON 输出的服务。须为 HTTPS 或本机 HTTP。">
            <input className="dc-input" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} />
          </Field>
          <Field label="模型">
            <input className="dc-input" value={model} onChange={(event) => setModel(event.target.value)} />
          </Field>
          <Field label="API Key" hint={status?.env_key ? "留空时使用环境变量 OPENAI_API_KEY。" : "仅保存在本次会话中，关闭应用后需重新输入。"}>
            <input className="dc-input" type="password" autoComplete="off" value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} />
          </Field>
        </>
      ) : (
        <>
          <div className="dc-connection">
            <span>{status?.account ? `已登录 · ${status.account}` : waiting ? "等待浏览器授权" : "登录以使用 ChatGPT 套餐"}</span>
            <div className="dc-row-actions">
              {!status?.account && !waiting && (
                <button type="button" className="dc-button is-primary" onClick={() => void handleLogin()} disabled={busy}>
                  Continue with ChatGPT
                </button>
              )}
              {waiting && (
                <button type="button" className="dc-button" onClick={() => void handleCancelLogin()}>
                  取消登录
                </button>
              )}
              {status?.account && (
                <>
                  <button type="button" className="dc-button" onClick={() => void refreshModels()} disabled={busy}>
                    刷新模型
                  </button>
                  <button type="button" className="dc-button" onClick={() => void handleLogout()} disabled={busy}>
                    退出
                  </button>
                </>
              )}
            </div>
          </div>
          <Field label="模型">
            <select className="dc-input" value={chatgptModel} disabled={models.length === 0} onChange={(event) => setChatgptModel(event.target.value)}>
              {models.length === 0 && <option value={chatgptModel}>{chatgptModel || "登录并加载模型后选择"}</option>}
              {models.map((item) => (
                <option key={item.slug} value={item.slug}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="推理强度" hint={selectedModel && selectedModel.efforts.length > 0 ? "推理强度越高，分析通常越慢，使用的额度也可能更多。" : "当前模型使用默认推理设置。"}>
            <select className="dc-input" value={effortChoices.includes(effort) ? effort : ""} disabled={effortChoices.length <= 1} onChange={(event) => setEffort(event.target.value)}>
              {effortChoices.map((value) => (
                <option key={value || "default"} value={value}>
                  {EFFORT_LABELS[value] ?? value}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
      <StatusLine text={message} tone={tone} />
    </Dialog>
  );
}
