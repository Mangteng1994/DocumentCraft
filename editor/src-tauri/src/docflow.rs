//! 调用 Python 核心 `docflow` 的 sidecar 桥。
//!
//! 定位顺序：
//! 1. 环境变量 `DOCUMENTCRAFT_DOCFLOW` 指向的可执行文件；
//! 2. 与编辑器同目录的 `DocumentCraft-cli.exe`（`scripts/build-sidecar.ps1` 的产物）；
//! 3. 开发时仓库内的 `.venv` Python，以 `-m documentcraft` 运行 `core/src/` 下的源码。
//!
//! 每次调用启动一个进程，参数走命令行，较大的输入经标准输入传 JSON。
//! `docflow_run` 返回标准输出的最后一行 JSON；`docflow_stream` 把每一行 JSON 依次推给前端，
//! 供 Copilot 逐字显示回答。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

/// 进行中的 sidecar 进程，按前端给的任务 id 记录，供取消使用。
#[derive(Default)]
pub struct Jobs(Arc<Mutex<HashMap<String, Child>>>);

const DOCFLOW_ENV: &str = "DOCUMENTCRAFT_DOCFLOW";
const SIDECAR_NAME: &str = "DocumentCraft-cli.exe";
/// API Key 只经环境变量传给子进程，不出现在命令行参数里，也不写入设置文件。
const API_KEY_ENV: &str = "DOCUMENTCRAFT_API_KEY";

fn docflow_command() -> Result<Command, String> {
    if let Ok(value) = std::env::var(DOCFLOW_ENV) {
        if !value.trim().is_empty() {
            return Ok(Command::new(value));
        }
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(folder) = executable.parent() {
            let sidecar = folder.join(SIDECAR_NAME);
            if sidecar.is_file() {
                return Ok(Command::new(sidecar));
            }
        }
    }
    // 开发模式：CARGO_MANIFEST_DIR 是 editor/src-tauri，仓库根目录在两级之上。
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    let python = repository.join(".venv").join("Scripts").join("python.exe");
    if !python.is_file() {
        return Err(format!(
            "找不到 docflow。请设置 {DOCFLOW_ENV}，或在仓库根目录创建 .venv 并安装 DocumentCraft。"
        ));
    }
    let mut command = Command::new(python);
    command.arg("-m").arg("documentcraft");
    command.env("PYTHONPATH", repository.join("core").join("src"));
    Ok(command)
}

fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：GUI 应用启动控制台子进程时不弹出黑窗口。
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// 标准输出每读到一行就调用一次，用于流式推送。
type LineSink = Box<dyn Fn(String) + Send>;

fn run_blocking(
    jobs: Arc<Mutex<HashMap<String, Child>>>,
    job: String,
    args: Vec<String>,
    input: Option<String>,
    api_key: Option<String>,
    on_line: Option<LineSink>,
) -> Result<String, String> {
    let mut command = docflow_command()?;
    command.args(&args);
    // 固定 UTF-8，避免 Windows 代码页改写中文路径和批注。
    command.env("PYTHONIOENCODING", "utf-8");
    command.env("PYTHONUTF8", "1");
    command.env_remove(API_KEY_ENV);
    if let Some(key) = api_key {
        if !key.is_empty() {
            command.env(API_KEY_ENV, key);
        }
    }
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    hide_console(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 docflow：{error}"))?;
    let mut stdin = child.stdin.take();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取 docflow 输出。".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取 docflow 输出。".to_string())?;
    {
        let mut table = jobs.lock().map_err(|_| "任务表不可用。".to_string())?;
        table.insert(job.clone(), child);
    }

    // 输入写完立即关闭，子进程才能读到 EOF。
    if let Some(mut pipe) = stdin.take() {
        if let Some(text) = input {
            let _ = pipe.write_all(text.as_bytes());
        }
    }
    let error_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stderr.read_to_end(&mut buffer);
        buffer
    });
    // 按行读取：流式调用时每行立即推给前端，普通调用只保留最后一行。
    let mut lines: Vec<String> = Vec::new();
    let mut read_result: std::io::Result<()> = Ok(());
    for line in BufReader::new(stdout).lines() {
        match line {
            Ok(text) => {
                if let Some(sink) = &on_line {
                    sink(text.clone());
                }
                lines.push(text);
            }
            Err(error) => {
                read_result = Err(error);
                break;
            }
        }
    }
    let error_output = error_reader.join().unwrap_or_default();

    let child = {
        let mut table = jobs.lock().map_err(|_| "任务表不可用。".to_string())?;
        table.remove(&job)
    };
    let status = match child {
        Some(mut process) => process.wait().ok(),
        // 取消时 docflow_cancel 已移除并结束进程。
        None => return Err("已取消。".to_string()),
    };
    read_result.map_err(|error| format!("读取 docflow 输出失败：{error}"))?;

    let text = lines.join("\n").trim().to_string();
    if text.is_empty() {
        let detail = String::from_utf8_lossy(&error_output);
        let tail: String = detail
            .lines()
            .rev()
            .take(6)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        let code = status
            .and_then(|value| value.code())
            .map(|value| value.to_string())
            .unwrap_or_else(|| "未知".to_string());
        return Err(format!("docflow 没有返回结果（退出码 {code}）。\n{tail}"));
    }
    // 只取最后一行，忽略第三方库可能打印到标准输出的提示。
    let last_line = text.lines().last().unwrap_or_default().to_string();
    Ok(last_line)
}

/// 运行一次 docflow 子命令，返回其 JSON 输出文本。
#[tauri::command]
pub async fn docflow_run(
    jobs: tauri::State<'_, Jobs>,
    job: String,
    args: Vec<String>,
    input: Option<String>,
    api_key: Option<String>,
) -> Result<String, String> {
    let table = jobs.0.clone();
    let task = tauri::async_runtime::spawn_blocking(move || run_blocking(table, job, args, input, api_key, None));
    task.await.map_err(|error| error.to_string())?
}

/// 运行一次会逐行输出 JSON 的 docflow 子命令（如 `chat`），每行经 channel 推给前端。
/// 返回最后一行，前端据此判断是否正常结束。
#[tauri::command]
pub async fn docflow_stream(
    jobs: tauri::State<'_, Jobs>,
    job: String,
    args: Vec<String>,
    input: Option<String>,
    api_key: Option<String>,
    on_line: tauri::ipc::Channel<String>,
) -> Result<String, String> {
    let table = jobs.0.clone();
    let sink: LineSink = Box::new(move |line| {
        let _ = on_line.send(line);
    });
    let task = tauri::async_runtime::spawn_blocking(move || run_blocking(table, job, args, input, api_key, Some(sink)));
    task.await.map_err(|error| error.to_string())?
}

/// 结束进行中的 docflow 任务，例如取消 ChatGPT 登录等待。
#[tauri::command]
pub fn docflow_cancel(jobs: tauri::State<'_, Jobs>, job: String) -> Result<(), String> {
    let child = {
        let mut table = jobs.0.lock().map_err(|_| "任务表不可用。".to_string())?;
        table.remove(&job)
    };
    if let Some(mut process) = child {
        // sidecar 可能再启动 ffmpeg、Pandoc 等子进程。只结束 sidecar 会让它们变成孤儿继续占用 CPU，
        // 所以 Windows 下先用 taskkill /T 结束整棵进程树，再兜底结束自己。
        kill_process_tree(process.id());
        let _ = process.kill();
        let _ = process.wait();
    }
    Ok(())
}

/// 结束指定进程及其全部子进程。非 Windows 平台没有对应的随系统命令，保持仅结束自身。
fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        command.stdin(Stdio::null());
        command.stdout(Stdio::null());
        command.stderr(Stdio::null());
        hide_console(&mut command);
        let _ = command.status();
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
    }
}

/// 返回进行中的 docflow 任务数。安装更新会替换 sidecar，任务未结束时前端据此拒绝安装。
#[tauri::command]
pub fn docflow_active(jobs: tauri::State<'_, Jobs>) -> Result<usize, String> {
    let table = jobs.0.lock().map_err(|_| "任务表不可用。".to_string())?;
    Ok(table.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 需要仓库根目录的 .venv（开发模式的 sidecar 定位规则）。
    #[test]
    fn runs_docflow_and_returns_json_line() {
        let jobs = Arc::new(Mutex::new(HashMap::new()));
        let args = vec!["ai".to_string(), "status".to_string()];
        let output = run_blocking(jobs.clone(), "status".to_string(), args, None, None, None).unwrap();
        let value: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(value["status"], "ok");
        assert!(jobs.lock().unwrap().is_empty());
    }

    #[test]
    fn passes_stdin_json_and_reports_errors_as_json() {
        let jobs = Arc::new(Mutex::new(HashMap::new()));
        let args = vec!["notes".to_string(), "add".to_string(), "--source".to_string(), "不存在.md".to_string()];
        let input = Some("{\"quote\":\"x\",\"body\":\"y\"}".to_string());
        let output = run_blocking(jobs, "add".to_string(), args, input, None, None).unwrap();
        let value: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(value["status"], "error");
    }
}
