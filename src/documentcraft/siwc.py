"""Windows 桌面应用的官方 Sign in with ChatGPT 客户端。"""

import base64
from dataclasses import dataclass
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import re
import secrets
from tempfile import NamedTemporaryFile
from threading import Event
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import uuid4
import webbrowser

import jwt

from .templates import ConversionError

ISSUER = "https://auth.openai.com"
RESOURCE = "https://api.openai.com/v1"
TOKEN_URL = f"{ISSUER}/api/accounts/oauth/token"
SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
REQUIRED_SCOPES = {"resource.invoke", "chatgpt.tokens.use.direct"}
CALLBACK = "/auth/callback"

# 套餐模型目录保证提供模型名称和 slug。缺少档位元数据时，仅采用官方文档已明确的档位。
# https://developers.openai.com/api/docs/models
_REASONING_EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh", "max")
_STANDARD_EFFORTS = ("low", "medium", "high", "xhigh")
_EFFORTS_BY_MODEL = {
    "gpt-6-astra": (*_STANDARD_EFFORTS, "max"),
    "gpt-6.1-sol": (*_STANDARD_EFFORTS, "max"),
    "gpt-6.1-terra": ("none", *_STANDARD_EFFORTS, "max"),
    "gpt-6-sol": ("none", *_STANDARD_EFFORTS, "max"),
    "gpt-6-luna": ("none", *_STANDARD_EFFORTS, "max"),
    "gpt-5.6": ("none", *_STANDARD_EFFORTS, "max"),
    "gpt-5.6-sol": ("none", *_STANDARD_EFFORTS, "max"),
    "gpt-5.6-terra": ("none", *_STANDARD_EFFORTS, "max"),
    "gpt-5.6-luna": ("none", *_STANDARD_EFFORTS, "max"),
    "gpt-5.5": ("none", *_STANDARD_EFFORTS),
    "gpt-5.5-pro": ("medium", "high", "xhigh"),
    "gpt-5.4": ("none", *_STANDARD_EFFORTS),
    "gpt-5.4-mini": ("none", *_STANDARD_EFFORTS),
    "gpt-5.4-nano": ("none", *_STANDARD_EFFORTS),
    "gpt-5.4-pro": ("medium", "high", "xhigh"),
    "gpt-5.3-codex": _STANDARD_EFFORTS,
    "gpt-5.2": ("none", *_STANDARD_EFFORTS),
    "gpt-5.2-pro": ("medium", "high", "xhigh"),
    "gpt-5.2-codex": _STANDARD_EFFORTS,
}


@dataclass(frozen=True)
class ChatGPTModel:
    """记录套餐模型的显示名称、请求标识和可选推理强度。"""

    display_name: str
    slug: str
    efforts: tuple[str, ...]


class _NoRedirect(HTTPRedirectHandler):
    """保持凭据请求在原始 OpenAI 域名。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _request(url: str, *, token: str = "", data: bytes | None = None,
             content_type: str = "application/json", timeout: int = 30):
    headers = {"Content-Type": content_type}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(url, data=data, headers=headers)
    return build_opener(_NoRedirect()).open(request, timeout=timeout)


def _folder() -> Path:
    return Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "DocumentCraft"


def _host_id() -> str:
    path = _folder() / "chatgpt-host-id"
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("x", encoding="ascii") as file:
            file.write(f"urn:uuid:{uuid4()}")
    except FileExistsError:
        pass
    return path.read_text(encoding="ascii").strip()


def _session_file() -> Path:
    return _folder() / "chatgpt-session.dpapi"


def _read_session() -> dict | None:
    try:
        encrypted = _session_file().read_bytes()
    except FileNotFoundError:
        return None

    import win32crypt
    from pywintypes import error as WindowsError

    try:
        _, raw = win32crypt.CryptUnprotectData(encrypted, None, None, None, 1)
        session = json.loads(raw)
        if not isinstance(session, dict):
            raise ValueError("ChatGPT 登录记录格式无效。")
        return session
    except (ValueError, WindowsError) as error:
        raise ConversionError("无法读取本机 ChatGPT 登录记录。请退出后重新登录。") from error


def _save_session(session: dict) -> None:
    import win32crypt

    # DPAPI 把凭据绑定到当前 Windows 用户，文件仅保存密文。
    path = _session_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    encrypted = win32crypt.CryptProtectData(
        json.dumps(session).encode("utf-8"), "DocumentCraft ChatGPT", None, None, None, 1,
    )
    with NamedTemporaryFile(dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        file.write(encrypted)
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def _tokens(parameters: dict) -> dict:
    payload = urlencode({**parameters, "resource": RESOURCE}).encode("ascii")
    try:
        with _request(TOKEN_URL, data=payload, content_type="application/x-www-form-urlencoded") as response:
            return json.load(response)
    except HTTPError as error:
        raise ConversionError(f"ChatGPT 授权请求失败（HTTP {error.code}）。请重新登录。") from error
    except (URLError, ValueError) as error:
        raise ConversionError("ChatGPT 授权服务连接失败。") from error


def _session_from_tokens(tokens: dict, previous: dict) -> dict:
    scopes = tokens.get("scope", previous.get("scope", ""))
    if not REQUIRED_SCOPES.issubset(scopes.split()):
        raise ConversionError("当前账号未授权 ChatGPT 套餐用量。")
    try:
        access = tokens["access_token"]
        expires = int(tokens["expires_in"])
        refresh = tokens.get("refresh_token", previous.get("refresh_token", ""))
        if not access or not refresh or expires <= 0:
            raise ValueError
    except (KeyError, TypeError, ValueError) as error:
        raise ConversionError("OpenAI 未返回完整的 ChatGPT 会话。") from error
    return {**previous, "scope": scopes, "access_token": access, "refresh_token": refresh,
            "expires_at": time.time() + expires}


def sign_in(cancel: Event | None = None) -> str:
    """在系统浏览器授权，通过 loopback 接收一次性授权码。"""
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    previous = _read_session() or {}
    issued_client = previous.get("client_id")
    result = {}

    class CallbackHandler(BaseHTTPRequestHandler):
        def setup(self):
            self.request.settimeout(3)
            super().setup()

        def log_message(self, format, *args):
            # 回调 URL 包含短时授权码。
            return

        def do_GET(self):
            target = urlsplit(self.path)
            values = parse_qs(target.query)
            returned_state = values.get("state", [""])[0]
            if target.path != CALLBACK or not secrets.compare_digest(returned_state, state):
                self.send_error(400, "Invalid authorization callback")
                return
            for field in ("code", "client_id", "error"):
                result[field] = values.get(field, [""])[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write("授权回调已收到，请返回 DocumentCraft 查看结果。".encode("utf-8"))

    with HTTPServer(("127.0.0.1", 0), CallbackHandler) as listener:
        listener.timeout = 1
        redirect_uri = f"http://127.0.0.1:{listener.server_port}{CALLBACK}"
        params = {
            "client_id": issued_client or "dynamic_agent_client", "ext_agent_host_id": _host_id(),
            "response_type": "code", "redirect_uri": redirect_uri, "scope": SCOPE,
            "resource": RESOURCE, "state": state, "nonce": nonce,
            "code_challenge_method": "S256", "code_challenge": challenge,
        }
        if issued_client:
            if previous.get("id_token"):
                params["id_token_hint"] = previous["id_token"]
        else:
            params["agent_name_hint"] = "DocumentCraft"
        url = f"{ISSUER}/api/accounts/authorize?{urlencode(params)}"
        if not webbrowser.open(url):
            raise ConversionError("无法打开默认浏览器。")
        deadline = time.monotonic() + 180
        while not result and time.monotonic() < deadline:
            if cancel is not None and cancel.is_set():
                raise ConversionError("已取消等待 ChatGPT 登录。")
            listener.handle_request()

    if cancel is not None and cancel.is_set():
        raise ConversionError("已取消等待 ChatGPT 登录。")
    if not result:
        raise ConversionError("等待浏览器授权超时。请重试，已有授权可直接刷新模型。")
    if result.get("error") or not result.get("code"):
        raise ConversionError("浏览器未完成 ChatGPT 授权。请重试。")
    client_id = result["client_id"] or issued_client
    if not client_id or client_id == "dynamic_agent_client" or (issued_client and client_id != issued_client):
        raise ConversionError("ChatGPT 没有返回匹配的应用注册 ID。")
    tokens = _tokens({
        "grant_type": "authorization_code", "client_id": client_id, "code": result["code"],
        "code_verifier": verifier, "redirect_uri": redirect_uri,
    })
    try:
        id_token = tokens["id_token"]
        keys = jwt.PyJWKClient(f"{ISSUER}/.well-known/jwks.json", timeout=20)
        key = keys.get_signing_key_from_jwt(id_token)
        identity = jwt.decode(
            id_token, key.key, algorithms=["RS256"], issuer=ISSUER, audience=client_id,
            options={"require": ["iss", "aud", "exp", "sub", "nonce"]},
        )
        if identity["nonce"] != nonce or (issued_client and identity["sub"] != previous["subject"]):
            raise ValueError
    except (jwt.PyJWTError, KeyError, ValueError, TypeError) as error:
        raise ConversionError("无法验证 ChatGPT 身份令牌。") from error
    session = _session_from_tokens(tokens, {
        "client_id": client_id, "id_token": id_token,
        "subject": identity["sub"], "email": identity.get("email", ""),
    })
    if cancel is not None and cancel.is_set():
        raise ConversionError("已取消等待 ChatGPT 登录。")
    _save_session(session)
    return session["email"] or "ChatGPT 账号"


def access_token() -> str:
    """返回本机授权凭据，并在过期前刷新会话。"""
    session = _read_session()
    if session is None:
        raise ConversionError("请先在 AI 设置中使用 ChatGPT 登录。")
    if session["expires_at"] < time.time() + 60:
        tokens = _tokens({
            "grant_type": "refresh_token", "client_id": session["client_id"],
            "refresh_token": session["refresh_token"],
        })
        session = _session_from_tokens(tokens, session)
        _save_session(session)
    return session["access_token"]


def saved_account() -> str | None:
    """读取本机已有会话的账号名称，不发起网络请求。"""
    session = _read_session()
    if session is None:
        return None
    return session.get("email") or "ChatGPT 账号"


def _model_efforts(item: dict) -> tuple[str, ...]:
    """优先使用目录返回的档位，缺少元数据时识别已知模型和日期快照。"""
    levels = item.get("supported_reasoning_levels")
    if isinstance(levels, list):
        advertised = [
            level.get("effort")
            for level in levels
            if isinstance(level, dict)
        ]
        return tuple(effort for effort in _REASONING_EFFORTS if effort in advertised)

    # 快照继承同名基础模型的能力。其他后缀可能代表不同能力的模型。
    slug = re.sub(r"-20\d{2}-\d{2}-\d{2}$", "", item["slug"])
    return _EFFORTS_BY_MODEL.get(slug, ())


def account_models() -> list[ChatGPTModel]:
    """列出当前账号对应用可见的模型。"""
    try:
        with _request(f"{RESOURCE}/models", token=access_token()) as response:
            catalog = json.load(response)
        return [
            ChatGPTModel(item["display_name"], item["slug"], _model_efforts(item))
            for item in catalog["models"]
            if item.get("visibility") == "list"
        ]
    except HTTPError as error:
        raise ConversionError(f"无法读取 ChatGPT 模型列表（HTTP {error.code}）。") from error
    except (URLError, ValueError, KeyError, TypeError) as error:
        raise ConversionError("无法读取 ChatGPT 模型列表。") from error


def analyze_report(model: str, instructions: str, report: str, *, reasoning_effort: str = "") -> str:
    """使用 ChatGPT 套餐调用公开 Responses API，读取完整流。"""
    data = {
        "model": model, "instructions": instructions, "store": False, "stream": True,
        "input": [{"role": "user", "content": report}],
    }
    # 使用模型默认档位时省略 reasoning，以兼容不接受该参数的模型。
    if reasoning_effort:
        data["reasoning"] = {"effort": reasoning_effort}
    fragments = []
    try:
        with _request(
            f"{RESOURCE}/responses", token=access_token(),
            data=json.dumps(data).encode("utf-8"), timeout=180,
        ) as response:
            event_lines = []
            for raw in response:
                line = raw.decode("utf-8").rstrip("\r\n")
                if line.startswith("data:"):
                    event_lines.append(line[5:].lstrip())
                if line or not event_lines:
                    continue
                event = json.loads("\n".join(event_lines))
                event_lines.clear()
                kind = event.get("type")
                if kind == "response.output_text.delta":
                    fragments.append(event["delta"])
                elif kind == "response.completed":
                    return "".join(fragments)
                elif kind in {"response.failed", "response.incomplete", "error"}:
                    error = (event.get("response") or {}).get("error") or event
                    code = error.get("code", kind)
                    raise ConversionError(f"ChatGPT 分析未完成（{code}）。")
    except HTTPError as error:
        raise ConversionError(f"ChatGPT 分析请求失败（HTTP {error.code}）。") from error
    except (URLError, ValueError, KeyError) as error:
        raise ConversionError("ChatGPT 分析连接失败或响应无法解析。") from error
    raise ConversionError("ChatGPT 返回流提前结束。")


def sign_out() -> None:
    """撤销本应用的 ChatGPT 会话并清理本机凭据。"""
    session = _read_session()
    if session is None:
        return
    try:
        with _request(f"{ISSUER}/.well-known/openid-configuration") as response:
            endpoint = json.load(response)["revocation_endpoint"]
        target = urlsplit(endpoint)
        if target.scheme != "https" or target.netloc != urlsplit(ISSUER).netloc:
            raise ValueError
        data = urlencode({
            "token": session["refresh_token"], "token_type_hint": "refresh_token",
            "client_id": session["client_id"],
        }).encode("ascii")
        with _request(endpoint, data=data, content_type="application/x-www-form-urlencoded"):
            pass
    except (URLError, ValueError, KeyError) as error:
        raise ConversionError("无法撤销 ChatGPT 授权。请检查网络后重试。") from error
    _session_file().unlink(missing_ok=True)
