"""核对 Office 媒体压缩前后的包：条目、非媒体内容、媒体尺寸与时长、文档库加载（DC-073）。

用法（需已 ``pip install -e core``，视频核对需要 ffmpeg）：
    python core/tools/verify_office_media.py 原文件.pptx 压缩版.pptx
退出码 0 表示全部通过。python-pptx 与 python-docx 存在时额外比对形状位置与段落数量。
"""

import argparse
import hashlib
import io
import json
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from documentcraft.media_compress import (
    COPY_BUFFER_SIZE,
    EXTENSION_KIND,
    MEDIA_DIRS,
    display_size,
    find_ffmpeg,
    probe_video,
    subprocess_flags,
)
from PIL import Image


def sha256_of(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> str:
    """流式计算条目解压后内容的 SHA-256。"""
    digest = hashlib.sha256()
    with archive.open(info) as reader:
        for block in iter(lambda: reader.read(COPY_BUFFER_SIZE), b""):
            digest.update(block)
    return digest.hexdigest()


def count_video_frames(ffmpeg: str, path: Path) -> int:
    """解码并统计画面帧数，用于确认重编码没有丢帧。

    不能数压缩包：MPEG-4 Part 2 等旧编码会带不含画面的空包，包数比画面数多一，
    与重编码是否丢帧无关。
    """
    completed = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", str(path), "-map", "0:v:0", "-f", "null", "-"],
        capture_output=True,
        text=True,
        errors="replace",
        stdin=subprocess.DEVNULL,
        creationflags=subprocess_flags(),
    )
    frames = re.findall(r"frame=\s*(\d+)", completed.stderr)
    if not frames:
        return -1
    return int(frames[-1])


def dpi_of(image: Image.Image) -> tuple[int, int]:
    """取整后的 DPI，缺失时为 (0, 0)。"""
    return tuple(round(value) for value in image.info.get("dpi", (0, 0)))


def verify_image(kind: str, before_bytes: bytes, after_bytes: bytes, allow_lossy_png: bool) -> tuple[dict, list[str]]:
    """核对图片：像素尺寸、DPI、ICC，无损 PNG 另核对解码像素。"""
    report: dict = {}
    problems: list[str] = []
    with Image.open(io.BytesIO(before_bytes)) as left, Image.open(io.BytesIO(after_bytes)) as right:
        report["size"] = list(left.size)
        if left.size != right.size:
            problems.append("像素尺寸变化")
        report["dpi_before"] = list(dpi_of(left))
        report["dpi_after"] = list(dpi_of(right))
        if dpi_of(left) != dpi_of(right):
            problems.append("DPI 变化")
        # oxipng 的 safe 模式把 sRGB 的 iCCP 换成等价的 sRGB 块，颜色语义不变；非 sRGB 配置必须原样保留。
        same_icc = left.info.get("icc_profile") == right.info.get("icc_profile")
        srgb_marked = kind == "png" and "srgb" in right.info
        if not (same_icc or srgb_marked):
            problems.append("ICC 配置变化")
        report["exif_kept"] = ("exif" in left.info) == ("exif" in right.info)
        if kind == "png":
            # oxipng 会把 RGBA 约简为调色板等更省的色彩类型，模式变化正常，统一转 RGBA 后比较解码像素。
            identical = left.convert("RGBA").tobytes() == right.convert("RGBA").tobytes()
            report["pixels_identical"] = identical
            if not identical and not allow_lossy_png:
                problems.append("PNG 像素变化")
    return report, problems


def verify_video(ffmpeg: str, name: str, before_bytes_path: Path, after_bytes_path: Path) -> tuple[dict, list[str]]:
    """核对视频：显示尺寸、旋转、时长、音轨与帧数。"""
    left = probe_video(ffmpeg, before_bytes_path)
    right = probe_video(ffmpeg, after_bytes_path)
    report = {
        "display_before": list(display_size(left)),
        "display_after": list(display_size(right)),
        "rotation_before": left["rotation"],
        "rotation_after": right["rotation"],
        "duration_diff": round(abs(left["duration"] - right["duration"]), 3),
        "audio_kept": bool(left["audio_codec"]) == bool(right["audio_codec"]),
        "frames_before": count_video_frames(ffmpeg, before_bytes_path),
        "frames_after": count_video_frames(ffmpeg, after_bytes_path),
    }
    problems: list[str] = []
    if report["display_before"] != report["display_after"]:
        problems.append("显示尺寸变化")
    if report["rotation_before"] != report["rotation_after"]:
        problems.append("旋转标记变化")
    if report["duration_diff"] > 0.25:
        problems.append("时长变化")
    if not report["audio_kept"]:
        problems.append("音轨变化")
    if report["frames_before"] != report["frames_after"]:
        problems.append("帧数变化")
    return report, problems


def load_with_library(original: Path, compressed: Path, failures: list[str]) -> str:
    """用 python-pptx / python-docx 加载两个文件，比对形状位置或段落数量。库不存在时跳过。"""
    suffix = original.suffix.lower()
    if suffix == ".pptx":
        try:
            from pptx import Presentation
        except ImportError:
            return "未安装 python-pptx，跳过"

        def layout(path: Path) -> list:
            deck = Presentation(str(path))
            rows = []
            for slide in deck.slides:
                for shape in slide.shapes:
                    rows.append((shape.shape_type, shape.left, shape.top, shape.width, shape.height))
            return rows

        same = layout(original) == layout(compressed)
        if not same:
            failures.append("pptx 形状位置不一致")
        return f"pptx 形状位置一致={same}"
    if suffix == ".docx":
        from docx import Document

        def count(path: Path) -> tuple[int, int]:
            document = Document(str(path))
            return len(document.paragraphs), len(document.inline_shapes)

        same = count(original) == count(compressed)
        if not same:
            failures.append("docx 段落或图片数量不一致")
        return f"docx 段落与图片数量一致={same}"
    return "未检查"


def verify_package(original: Path, compressed: Path, allow_lossy_png: bool = False) -> dict:
    """核对压缩前后的包，返回含 passed 与 failures 的报告。"""
    ffmpeg = find_ffmpeg()
    failures: list[str] = []
    media: list[dict] = []
    changed_non_media: list[str] = []
    with zipfile.ZipFile(original) as before, zipfile.ZipFile(compressed) as after:
        names_before = [item.filename for item in before.infolist()]
        names_after = [item.filename for item in after.infolist()]
        same_names = names_before == names_after
        if not same_names:
            failures.append("条目名或顺序不同")
        with tempfile.TemporaryDirectory(prefix="dc_verify_") as temp_name:
            work_dir = Path(temp_name)
            for info_before in before.infolist():
                if info_before.filename not in names_after:
                    continue
                info_after = after.getinfo(info_before.filename)
                is_media = info_before.filename.startswith(MEDIA_DIRS) and not info_before.is_dir()
                same_bytes = sha256_of(before, info_before) == sha256_of(after, info_after)
                if not is_media:
                    if not same_bytes:
                        changed_non_media.append(info_before.filename)
                    continue
                if same_bytes:
                    continue
                suffix = Path(info_before.filename).suffix.lower()
                kind = EXTENSION_KIND.get(suffix)
                report = {"name": info_before.filename, "before": info_before.file_size, "after": info_after.file_size}
                problems: list[str] = []
                if kind in ("jpeg", "png"):
                    detail, problems = verify_image(kind, before.read(info_before), after.read(info_after), allow_lossy_png)
                    report.update(detail)
                elif kind == "video":
                    if ffmpeg is None:
                        problems = ["缺少 ffmpeg，无法核对视频"]
                    else:
                        left_path = work_dir / ("a" + suffix)
                        right_path = work_dir / ("b" + suffix)
                        with before.open(info_before) as reader, open(left_path, "wb") as writer:
                            writer.write(reader.read())
                        with after.open(info_after) as reader, open(right_path, "wb") as writer:
                            writer.write(reader.read())
                        detail, problems = verify_video(ffmpeg, info_before.filename, left_path, right_path)
                        report.update(detail)
                        left_path.unlink()
                        right_path.unlink()
                else:
                    problems = ["媒体类别无法核对"]
                for problem in problems:
                    failures.append(f"{info_before.filename} {problem}")
                media.append(report)
    if changed_non_media:
        failures.append("非媒体条目变化：" + ", ".join(changed_non_media))
    library = load_with_library(original, compressed, failures)
    return {
        "passed": not failures,
        "failures": failures,
        "entries_same": same_names,
        "non_media_identical": not changed_non_media,
        "library": library,
        "changed_media": media,
    }


def main() -> int:
    """命令行入口。"""
    parser = argparse.ArgumentParser(description="核对 Office 媒体压缩前后的包")
    parser.add_argument("original", type=Path)
    parser.add_argument("compressed", type=Path)
    parser.add_argument("--allow-lossy-png", action="store_true")
    args = parser.parse_args()
    result = verify_package(args.original, args.compressed, args.allow_lossy_png)
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False, indent=2).encode("utf-8") + b"\n")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
