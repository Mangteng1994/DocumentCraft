"""Office 文档内嵌媒体压缩（DC-073）。

docx、pptx、xlsx 本质是 zip 包，媒体存放在 ``ppt/media/`` 等目录，页面通过文件名引用它们。
本模块在 zip 层「同名替换」媒体内容：

1. 条目名、条目顺序和所有非媒体条目的内容不变，所以页面位置、裁剪、动画、视频封面引用不受影响；
2. 媒体扩展名和像素 / 画面尺寸不变，不缩放、不改格式；
3. 压缩结果不够小、尺寸校验不通过或遇到不认识的格式时保留原媒体。

视频由随包的 ffmpeg（独立进程）经 libx264 重编码，JPEG 用 Pillow 重编码并保留 EXIF、ICC、DPI，
PNG 用 oxipng 无损优化，JPEG 另有 MozJPEG 无损优化作为候选。
"""

from __future__ import annotations

import hashlib
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .templates import ConversionError

# 只处理这些 Office 包。带宏的变体结构相同，但本轮不开放，避免改动含宏文件。
OFFICE_SUFFIXES = (".pptx", ".docx", ".xlsx")

# Office 包内存放媒体的目录。嵌入的 OLE、xlsx、字体等一律原样复制。
MEDIA_DIRS = ("ppt/media/", "word/media/", "xl/media/")

# 扩展名到媒体类别的映射。类别必须同时通过文件头嗅探，防止改名伪装的文件被误处理。
EXTENSION_KIND = {
    ".jpg": "jpeg",
    ".jpeg": "jpeg",
    ".jpe": "jpeg",
    ".png": "png",
    ".mp4": "video",
    ".m4v": "video",
    ".mov": "video",
}

# 节省不足该比例的结果视为无效，保留原文件，避免无谓的重编码损失。
MIN_SAVING_RATIO = 0.05

# 小于该体积的图片不值得处理，跳过可以省下大量文档里的图标和小插图。
MIN_IMAGE_BYTES = 32 * 1024

# 视频时长允许的偏差（秒）。超出说明重编码丢帧或截断，保留原视频。
MAX_DURATION_DRIFT = 0.25

COPY_BUFFER_SIZE = 1024 * 1024
WORK_DIR_PREFIX = "documentcraft-compress-"
STALE_WORK_DIR_SECONDS = 24 * 3600
FFMPEG_ENV = "DOCUMENTCRAFT_FFMPEG"
PROGRESS_INTERVAL_SECONDS = 0.4

Emit = Callable[[dict], None]


@dataclass
class CompressOptions:
    """压缩参数。界面只暴露视频和图片两个开关，其余取默认值。"""

    video: bool = True
    image: bool = True
    crf: int = 23
    preset: str = "fast"
    jpeg_quality: int = 85
    png_lossy: bool = False


def find_ffmpeg() -> str | None:
    """定位 ffmpeg：打包内置、环境变量、PATH。找不到返回 None，视频将被跳过并提示。"""
    if getattr(sys, "frozen", False):
        bundled = Path(__file__).resolve().parents[1] / "engine" / "ffmpeg.exe"
        if bundled.is_file():
            return str(bundled)
    override = os.environ.get(FFMPEG_ENV, "").strip()
    if override and Path(override).is_file():
        return override
    return shutil.which("ffmpeg")


def subprocess_flags() -> int:
    """Windows 下不弹控制台窗口，并降低优先级，压缩期间不拖慢编辑器。"""
    if sys.platform != "win32":
        return 0
    no_window = 0x0800_0000
    below_normal = 0x0000_4000
    return no_window | below_normal


def sniff_kind(head: bytes, name: str) -> str | None:
    """按文件头和扩展名判断媒体类别，两者不一致时返回 None（由调用方跳过）。"""
    suffix = Path(name).suffix.lower()
    expected = EXTENSION_KIND.get(suffix)
    if expected is None:
        return None
    if expected == "jpeg" and head[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if expected == "png" and head[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if expected == "video" and head[4:8] in (b"ftyp", b"moov", b"mdat", b"free", b"wide"):
        return "video"
    return None


def probe_video(ffmpeg: str, path: Path) -> dict:
    """用 ``ffmpeg -i`` 的 stderr 解析视频信息。

    随包 ffmpeg 不带 ffprobe，因此统一解析 stderr 文本。
    """
    completed = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", str(path)],
        capture_output=True,
        text=True,
        errors="replace",
        stdin=subprocess.DEVNULL,
        creationflags=subprocess_flags(),
    )
    text = completed.stderr
    info: dict = {"width": 0, "height": 0, "rotation": 0, "duration": 0.0, "video_codec": "", "audio_codec": ""}
    duration_match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text)
    if duration_match:
        hours, minutes, seconds = duration_match.groups()
        info["duration"] = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    video_match = re.search(r"Video:\s*(\w+).*?,\s(\d{2,5})x(\d{2,5})", text)
    if video_match:
        info["video_codec"] = video_match.group(1)
        info["width"] = int(video_match.group(2))
        info["height"] = int(video_match.group(3))
    audio_match = re.search(r"Audio:\s*(\w+)", text)
    if audio_match:
        info["audio_codec"] = audio_match.group(1)
    rotation_match = re.search(r"rotation of (-?\d+(?:\.\d+)?) degrees", text)
    if rotation_match:
        info["rotation"] = int(round(float(rotation_match.group(1)))) % 360
    return info


def display_size(info: dict) -> tuple[int, int]:
    """返回按旋转信息换算后的显示尺寸。"""
    width = info["width"]
    height = info["height"]
    if info["rotation"] in (90, 270):
        return height, width
    return width, height


def run_ffmpeg(command: list[str], duration: float, work_dir: Path, on_fraction: Callable[[float], None]) -> str | None:
    """运行 ffmpeg 并读取 ``-progress`` 输出，成功返回 None，失败返回错误尾部。"""
    error_path = work_dir / "ffmpeg-error.log"
    last_report = 0.0
    with open(error_path, "wb") as error_file:
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=error_file,
            text=True,
            errors="replace",
            creationflags=subprocess_flags(),
        )
        assert process.stdout is not None
        for line in process.stdout:
            if not line.startswith("out_time_us="):
                continue
            value = line.split("=", 1)[1].strip()
            if not value.isdigit() or duration <= 0:
                continue
            now = time.monotonic()
            if now - last_report < PROGRESS_INTERVAL_SECONDS:
                continue
            last_report = now
            on_fraction(min(1.0, int(value) / 1_000_000 / duration))
        process.wait()
        process.stdout.close()
    if process.returncode != 0:
        tail = error_path.read_text(encoding="utf-8", errors="replace").strip()[-300:]
        return f"ffmpeg 失败：{tail}"
    return None


def compress_video(ffmpeg: str, source: Path, target: Path, work_dir: Path, options: CompressOptions, on_fraction: Callable[[float], None]) -> str | None:
    """重编码视频，保持分辨率、帧时间和旋转信息。成功返回 None，需跳过时返回原因。"""
    info = probe_video(ffmpeg, source)
    if info["width"] == 0:
        return "无法识别视频流"
    # yuv420p 要求偶数宽高。奇数尺寸若补边会改变分辨率，因此直接跳过。
    if info["width"] % 2 or info["height"] % 2:
        return "奇数宽高，跳过以避免改变分辨率"
    command = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats",
        # 关闭自动旋转：手机视频的旋转存放在显示矩阵里，自动旋转会把画面烘焙成竖屏并丢掉旋转标记。
        "-noautorotate",
        "-i", str(source),
        # 显式选流，避免 data / tmcd 流导致 mp4 封装失败。
        "-map", "0:v:0", "-map", "0:a?",
        "-c:v", "libx264", "-crf", str(options.crf), "-preset", options.preset,
        "-pix_fmt", "yuv420p",
        # 保留原始时间戳，不改变帧率和时长。
        "-fps_mode", "passthrough",
    ]
    if info["audio_codec"] == "aac":
        command += ["-c:a", "copy"]
    else:
        command += ["-c:a", "aac", "-b:a", "128k"]
    # 容器必须与原扩展名一致：[Content_Types].xml 按扩展名声明类型，.mov 写成 mp4 容器会与声明不符。
    container = "mov" if source.suffix.lower() == ".mov" else "mp4"
    command += ["-movflags", "+faststart", "-f", container, str(target)]
    failure = run_ffmpeg(command, info["duration"], work_dir, on_fraction)
    if failure:
        return failure
    # 校验：显示尺寸必须与原视频一致，时长偏差在容忍范围内，音轨有无一致。
    output = probe_video(ffmpeg, target)
    if display_size(output) != display_size(info):
        return "校验失败：显示尺寸发生变化，保留原视频"
    if abs(output["duration"] - info["duration"]) > MAX_DURATION_DRIFT:
        return "校验失败：时长发生变化，保留原视频"
    if bool(output["audio_codec"]) != bool(info["audio_codec"]):
        return "校验失败：音轨发生变化，保留原视频"
    return None


def optimize_png(data: bytes, lossy: bool) -> bytes | str:
    """优化 PNG。成功返回新字节，需跳过时返回原因字符串。"""
    try:
        import oxipng
    except ImportError as error:
        raise ConversionError("缺少 PNG 优化组件 oxipng，请重新获取完整安装包。") from error
    from PIL import Image

    # 动画 PNG 带 acTL 块，只处理静态图以免丢帧。
    header = data.split(b"IDAT", 1)[0]
    if b"acTL" in header:
        return "动画 PNG，跳过"
    candidate = data
    if lossy:
        # 有损路径：256 色调色板量化，适合截图与图表。当前界面不开放。
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            if image.mode == "RGBA":
                quantized = image.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.FLOYDSTEINBERG)
            elif image.mode == "RGB":
                quantized = image.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
            else:
                quantized = None
            if quantized is not None:
                buffer = io.BytesIO()
                # quantize 返回的图片不带元数据，ICC 与 DPI 需显式带回。
                quantized.save(buffer, "PNG", icc_profile=image.info.get("icc_profile"), dpi=image.info.get("dpi"))
                candidate = buffer.getvalue()
    # oxipng 的 safe 剥离只移除不影响渲染的块，保留非 sRGB 的 ICC；sRGB 的 iCCP 会换成等价的 sRGB 块。
    return oxipng.optimize_from_memory(candidate, level=2, strip=oxipng.StripChunks.safe())


def luma_table_sum(image) -> int:
    """JPEG 亮度量化表之和，越大表示压得越狠。取不到时返回 0。"""
    tables = getattr(image, "quantization", None)
    if not tables or 0 not in tables:
        return 0
    return int(sum(tables[0]))


def optimize_jpeg(data: bytes, quality: int) -> tuple[bytes | None, str]:
    """优化 JPEG，返回（新字节或 None，方法名或跳过原因）。

    候选有两个：有损重编码（保留 EXIF、ICC、DPI）和 MozJPEG 无损优化，取体积更小者。
    """
    from PIL import Image, JpegImagePlugin

    candidates: list[tuple[bytes, str]] = []
    with Image.open(io.BytesIO(data)) as image:
        if image.mode not in ("RGB", "L"):
            return None, f"色彩模式 {image.mode}，跳过"
        exif = image.info.get("exif", b"")
        icc_profile = image.info.get("icc_profile")
        dpi = image.info.get("dpi")
        source_table_sum = luma_table_sum(image)
        image.load()
        buffer = io.BytesIO()
        save_options: dict = {"quality": quality, "optimize": True, "exif": exif, "icc_profile": icc_profile}
        # 保持原色度采样，避免彩色边缘被额外模糊。手机照片常是 MPO（多图 JPEG），Pillow 对它不接受 "keep"，
        # 因此显式读取采样方式；读不出时（4:4:0 等少见采样）退回默认。
        sampling = JpegImagePlugin.get_sampling(image)
        if sampling in (0, 1, 2):
            save_options["subsampling"] = sampling
        # dpi 必须带回：资源管理器的「分辨率」属性读取它，丢失会让用户误以为分辨率变了。
        if dpi:
            save_options["dpi"] = dpi
        image.save(buffer, "JPEG", **save_options)
        lossy = buffer.getvalue()
        has_icc = icc_profile is not None
        has_orientation = False
        if exif:
            has_orientation = image.getexif().get(274, 1) != 1
    # 代际损失保护：源文件量化表已不细于目标质量时，再有损编码只会叠加失真，改走无损路径。
    with Image.open(io.BytesIO(lossy)) as reencoded:
        target_table_sum = luma_table_sum(reencoded)
    if not (source_table_sum and source_table_sum >= target_table_sum):
        candidates.append((lossy, "lossy"))
    # MozJPEG 无损优化会清除全部元数据（含 DPI）。带 ICC、旋转标记或 DPI 的图片不走这条路，否则会改变显示或属性。
    if not has_icc and not has_orientation and not dpi:
        try:
            import mozjpeg_lossless_optimization

            candidates.append((mozjpeg_lossless_optimization.optimize(data), "lossless"))
        except ImportError:
            pass
    if not candidates:
        return None, "已是低质量 JPEG 且含元数据，保留原文件"
    best_bytes, best_method = min(candidates, key=lambda item: len(item[0]))
    return best_bytes, best_method


def image_size(data: bytes) -> tuple[int, int]:
    """读取图片像素尺寸。"""
    from PIL import Image

    with Image.open(io.BytesIO(data)) as image:
        return image.size


def process_media(
    ffmpeg: str | None,
    archive: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    kind: str,
    work_dir: Path,
    options: CompressOptions,
    on_fraction: Callable[[float], None],
) -> tuple[Path | None, str, str]:
    """压缩单个媒体条目。返回（新文件路径或 None，保留原因或 replaced，所用方法）。"""
    suffix = Path(info.filename).suffix
    source = work_dir / ("src_" + hashlib.sha1(info.filename.encode()).hexdigest() + suffix)
    with archive.open(info) as reader, open(source, "wb") as writer:
        shutil.copyfileobj(reader, writer, COPY_BUFFER_SIZE)
    target = work_dir / ("dst_" + source.name)
    # 单个媒体出错（损坏文件、罕见格式、解码失败）不应让整份文档的压缩中断：保留该媒体原样并记录原因。
    try:
        return process_media_file(ffmpeg, source, target, work_dir, kind, options, on_fraction)
    except ConversionError:
        raise
    except Exception as error:
        return None, f"处理失败，保留原文件：{error}", ""


def process_media_file(
    ffmpeg: str | None,
    source: Path,
    target: Path,
    work_dir: Path,
    kind: str,
    options: CompressOptions,
    on_fraction: Callable[[float], None],
) -> tuple[Path | None, str, str]:
    """压缩已解出到磁盘的媒体文件。返回（新文件路径或 None，保留原因或 replaced，所用方法）。"""
    method = ""
    if kind == "video":
        if ffmpeg is None:
            return None, "未找到 ffmpeg，视频保持原样", ""
        reason = compress_video(ffmpeg, source, target, work_dir, options, on_fraction)
        if reason:
            return None, reason, ""
        method = "x264"
    elif kind == "png":
        original = source.read_bytes()
        result = optimize_png(original, options.png_lossy)
        if isinstance(result, str):
            return None, result, ""
        if image_size(original) != image_size(result):
            return None, "校验失败：像素尺寸发生变化，保留原图", ""
        target.write_bytes(result)
        method = "lossy" if options.png_lossy else "lossless"
    else:
        original = source.read_bytes()
        result_bytes, detail = optimize_jpeg(original, options.jpeg_quality)
        if result_bytes is None:
            return None, detail, ""
        if image_size(original) != image_size(result_bytes):
            return None, "校验失败：像素尺寸发生变化，保留原图", ""
        target.write_bytes(result_bytes)
        method = detail
    before = source.stat().st_size
    after = target.stat().st_size
    if after > before * (1 - MIN_SAVING_RATIO):
        return None, f"节省不足 {MIN_SAVING_RATIO:.0%}，保留原文件", method
    return target, "replaced", method


def copy_entry(archive: zipfile.ZipFile, writer: zipfile.ZipFile, info: zipfile.ZipInfo) -> None:
    """按原 ZipInfo 复制条目，保持顺序、时间戳与压缩方式。"""
    new_info = zipfile.ZipInfo(info.filename, info.date_time)
    new_info.compress_type = info.compress_type
    new_info.external_attr = info.external_attr
    new_info.create_system = info.create_system
    new_info.file_size = info.file_size
    if info.is_dir():
        writer.writestr(new_info, b"")
        return
    with archive.open(info) as reader, writer.open(new_info, "w") as sink:
        shutil.copyfileobj(reader, sink, COPY_BUFFER_SIZE)


def write_replacement(writer: zipfile.ZipFile, info: zipfile.ZipInfo, replacement: Path) -> None:
    """写入替换后的媒体。媒体本身已压缩，使用 STORED 避免无谓的 deflate。"""
    new_info = zipfile.ZipInfo(info.filename, info.date_time)
    new_info.compress_type = zipfile.ZIP_STORED
    new_info.external_attr = info.external_attr
    new_info.create_system = info.create_system
    new_info.file_size = replacement.stat().st_size
    with open(replacement, "rb") as reader, writer.open(new_info, "w") as sink:
        shutil.copyfileobj(reader, sink, COPY_BUFFER_SIZE)


def output_path_for(source: Path) -> Path:
    """输出为同目录「原名_压缩版.后缀」，已存在时编号，绝不覆盖已有文件。"""
    candidate = source.with_name(f"{source.stem}_压缩版{source.suffix}")
    number = 2
    while candidate.exists() or candidate.is_symlink():
        candidate = source.with_name(f"{source.stem}_压缩版 ({number}){source.suffix}")
        number += 1
    return candidate


def purge_stale_work_dirs() -> None:
    """清理被取消或崩溃遗留的临时目录。取消时进程被直接结束，无法自行清理。"""
    root = Path(tempfile.gettempdir())
    now = time.time()
    for folder in root.glob(WORK_DIR_PREFIX + "*"):
        try:
            if folder.is_dir() and now - folder.stat().st_mtime > STALE_WORK_DIR_SECONDS:
                shutil.rmtree(folder, ignore_errors=True)
        except OSError:
            continue


def check_free_space(source: Path, largest_media: int) -> None:
    """压缩前检查磁盘：输出目录需容纳与原文件相当的体积，临时目录需容纳最大媒体的副本。"""
    output_free = shutil.disk_usage(source.parent).free
    if output_free < source.stat().st_size * 1.05:
        raise ConversionError("输出目录所在磁盘空间不足，请释放空间后重试。")
    temp_free = shutil.disk_usage(tempfile.gettempdir()).free
    if temp_free < largest_media * 2.2:
        raise ConversionError("临时目录所在磁盘空间不足，请释放空间后重试。")


def read_options(payload: dict) -> CompressOptions:
    """从编辑器传来的 JSON 构造参数，并把数值限制在安全范围。"""
    options = CompressOptions()
    options.video = bool(payload.get("video", True))
    options.image = bool(payload.get("image", True))
    crf = payload.get("crf", options.crf)
    if isinstance(crf, int) and 18 <= crf <= 32:
        options.crf = crf
    quality = payload.get("jpeg_quality", options.jpeg_quality)
    if isinstance(quality, int) and 60 <= quality <= 95:
        options.jpeg_quality = quality
    if payload.get("preset") in ("veryfast", "fast", "medium", "slow"):
        options.preset = payload["preset"]
    return options


def scan_media(archive: zipfile.ZipFile, options: CompressOptions) -> list[tuple[zipfile.ZipInfo, str]]:
    """列出会被处理的媒体条目及类别，按压缩包内顺序。"""
    selected: list[tuple[zipfile.ZipInfo, str]] = []
    for info in archive.infolist():
        if info.is_dir() or not info.filename.startswith(MEDIA_DIRS):
            continue
        with archive.open(info) as reader:
            head = reader.read(16)
        kind = sniff_kind(head, info.filename)
        if kind == "video" and options.video:
            selected.append((info, kind))
        elif kind in ("jpeg", "png") and options.image and info.file_size >= MIN_IMAGE_BYTES:
            selected.append((info, kind))
    return selected


def compress_office_media(source: Path, payload: dict, emit: Emit) -> dict:
    """压缩 Office 文档内嵌媒体并写入同目录「原名_压缩版.后缀」。

    进度以 JSON 对象经 emit 推送：start、file、progress、file_done，结束时返回含 status 的汇总。
    取消由编辑器直接结束进程，临时文件由下次启动时清理。
    """
    source = Path(source)
    if source.suffix.lower() not in OFFICE_SUFFIXES:
        raise ConversionError("只支持 pptx、docx、xlsx 文件；旧版 ppt、doc、xls 请先另存为新格式。")
    if not source.is_file():
        raise ConversionError(f"找不到文件：{source}")
    options = read_options(payload)
    if not options.video and not options.image:
        raise ConversionError("请至少选择一种压缩类型。")
    purge_stale_work_dirs()
    ffmpeg = find_ffmpeg() if options.video else None
    warnings: list[str] = []
    started = time.monotonic()
    try:
        archive_context = zipfile.ZipFile(source)
    except PermissionError as error:
        raise ConversionError("文件正被其他程序占用，请关闭后重试。") from error
    except zipfile.BadZipFile as error:
        raise ConversionError("文件不是有效的 Office 文档，或已损坏。") from error
    with archive_context as archive:
        selected = scan_media(archive, options)
        total_bytes = sum(info.file_size for info, _kind in selected)
        largest = max((info.file_size for info, _kind in selected), default=0)
        if options.video and ffmpeg is None and any(kind == "video" for _info, kind in selected):
            warnings.append("未找到 ffmpeg，文档中的视频保持原样。")
        check_free_space(source, largest)
        target = output_path_for(source)
        partial = target.with_name(target.name + ".part")
        # 上次被取消时留下的 .part 属于本功能，可以直接清掉。
        if partial.exists():
            partial.unlink()
        emit({"type": "start", "source": str(source), "media_count": len(selected), "media_bytes": total_bytes})
        selected_names = {info.filename: kind for info, kind in selected}
        done_bytes = 0
        index = 0
        files: list[dict] = []
        # 内容哈希缓存：PowerPoint 复制幻灯片后常出现内容完全相同的多份媒体，只压缩一次。
        cache: dict[str, tuple[Path | None, str, str]] = {}
        work_dir = Path(tempfile.mkdtemp(prefix=WORK_DIR_PREFIX))
        try:
            with zipfile.ZipFile(partial, "w") as writer:
                for info in archive.infolist():
                    kind = selected_names.get(info.filename)
                    if kind is None:
                        copy_entry(archive, writer, info)
                        continue
                    index += 1
                    entry_started = time.monotonic()
                    emit({"type": "file", "index": index, "count": len(selected), "name": info.filename, "kind": kind, "size": info.file_size})

                    def on_fraction(fraction: float, size: int = info.file_size, name: str = info.filename, base: int = done_bytes) -> None:
                        overall = (base + size * fraction) / total_bytes if total_bytes else 1.0
                        emit({"type": "progress", "name": name, "fraction": round(fraction, 3), "overall": round(overall, 4)})

                    digest = hashlib.sha256()
                    with archive.open(info) as reader:
                        for block in iter(lambda: reader.read(COPY_BUFFER_SIZE), b""):
                            digest.update(block)
                    key = digest.hexdigest()
                    if key in cache:
                        replacement, status, method = cache[key]
                    else:
                        replacement, status, method = process_media(ffmpeg, archive, info, kind, work_dir, options, on_fraction)
                        cache[key] = (replacement, status, method)
                    after = info.file_size
                    if replacement is not None:
                        write_replacement(writer, info, replacement)
                        after = replacement.stat().st_size
                    else:
                        copy_entry(archive, writer, info)
                    done_bytes += info.file_size
                    record = {
                        "name": info.filename,
                        "kind": kind,
                        "status": "replaced" if replacement is not None else "kept",
                        "reason": "" if replacement is not None else status,
                        "method": method,
                        "before": info.file_size,
                        "after": after,
                        "seconds": round(time.monotonic() - entry_started, 2),
                    }
                    files.append(record)
                    overall = done_bytes / total_bytes if total_bytes else 1.0
                    emit({"type": "file_done", "overall": round(overall, 4), **record})
            replaced = sum(1 for record in files if record["status"] == "replaced")
            before_total = source.stat().st_size
            if replaced == 0:
                partial.unlink(missing_ok=True)
                result_target: str | None = None
                after_total = before_total
            else:
                partial.replace(target)
                result_target = str(target)
                after_total = target.stat().st_size
        except BaseException:
            partial.unlink(missing_ok=True)
            raise
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)
    return {
        "type": "done",
        "status": "ok",
        "source": str(source),
        "target": result_target,
        "before_bytes": before_total,
        "after_bytes": after_total,
        "replaced": replaced,
        "kept": len(files) - replaced,
        "seconds": round(time.monotonic() - started, 1),
        "warnings": warnings,
        "files": files,
    }
