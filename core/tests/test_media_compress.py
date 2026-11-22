"""验证 Office 媒体压缩（DC-073）：同名替换、尺寸不变、非媒体条目不变、不覆盖已有文件。"""

import hashlib
import io
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

import numpy
from docx import Document
from docx.shared import Inches
from PIL import Image

from documentcraft import media_compress
from documentcraft.templates import ConversionError


def noisy_photo(width: int, height: int) -> Image.Image:
    """带噪声的渐变图，JPEG 重编码时有明显的体积下降。"""
    generator = numpy.random.default_rng(7)
    rows, columns = numpy.mgrid[0:height, 0:width]
    base = numpy.stack([columns / width * 255, rows / height * 255, (columns + rows) / (width + height) * 255], axis=-1)
    noise = generator.normal(0, 8, base.shape)
    return Image.fromarray(numpy.clip(base + noise, 0, 255).astype("uint8"))


def entry_digests(path: Path, skip_media: bool) -> dict[str, str]:
    """条目名到内容哈希的映射，可排除媒体目录。"""
    digests: dict[str, str] = {}
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            if skip_media and info.filename.startswith(media_compress.MEDIA_DIRS):
                continue
            digests[info.filename] = hashlib.sha256(archive.read(info)).hexdigest()
    return digests


class MediaCompressTest(unittest.TestCase):
    def setUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.directory = Path(self.folder.name)
        photo = noisy_photo(1600, 1200)
        photo_path = self.directory / "photo.jpg"
        photo.save(photo_path, quality=95, dpi=(300, 300))
        document = Document()
        document.add_paragraph("样例文档")
        document.add_picture(str(photo_path), width=Inches(4))
        self.source = self.directory / "样例.docx"
        document.save(self.source)

    def run_compress(self, source: Path, payload: dict | None = None) -> tuple[dict, list[dict]]:
        events: list[dict] = []
        result = media_compress.compress_office_media(source, payload or {}, events.append)
        return result, events

    def test_jpeg_is_recompressed_in_place_without_touching_other_entries(self) -> None:
        result, events = self.run_compress(self.source, {"video": False})
        target = Path(result["target"])
        self.assertEqual(target.name, "样例_压缩版.docx")
        self.assertEqual(result["replaced"], 1)
        self.assertLess(result["after_bytes"], result["before_bytes"])
        self.assertEqual(events[0]["type"], "start")
        # 条目名、顺序、非媒体内容完全一致。
        with zipfile.ZipFile(self.source) as before, zipfile.ZipFile(target) as after:
            self.assertEqual(before.namelist(), after.namelist())
            media = [name for name in before.namelist() if name.startswith("word/media/")][0]
            with Image.open(io.BytesIO(before.read(media))) as left, Image.open(io.BytesIO(after.read(media))) as right:
                self.assertEqual(left.size, right.size)
                self.assertEqual(tuple(round(value) for value in right.info["dpi"]), (300, 300))
        self.assertEqual(entry_digests(self.source, True), entry_digests(target, True))
        Document(str(target))

    def test_existing_output_is_never_overwritten(self) -> None:
        first, _ = self.run_compress(self.source, {"video": False})
        second, _ = self.run_compress(self.source, {"video": False})
        self.assertNotEqual(first["target"], second["target"])
        self.assertTrue(Path(second["target"]).name.endswith("_压缩版 (2).docx"))
        self.assertTrue(Path(first["target"]).is_file())

    def test_rejects_legacy_formats_and_empty_selection(self) -> None:
        legacy = self.directory / "旧.ppt"
        legacy.write_bytes(b"x")
        with self.assertRaises(ConversionError):
            self.run_compress(legacy)
        with self.assertRaises(ConversionError):
            self.run_compress(self.source, {"video": False, "image": False})

    def test_video_keeps_display_size_and_rotation_is_not_baked(self) -> None:
        ffmpeg = media_compress.find_ffmpeg()
        if ffmpeg is None:
            self.skipTest("没有 ffmpeg")
        clip = self.directory / "clip.mp4"
        subprocess.run(
            [ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2",
             "-vf", "noise=alls=15:allf=t", "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", str(clip)],
            check=True,
        )
        rotated = self.directory / "rotated.mp4"
        subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-display_rotation", "90", "-i", str(clip), "-c", "copy", str(rotated)], check=True)
        package = self.directory / "含视频.docx"
        with zipfile.ZipFile(self.source) as base, zipfile.ZipFile(package, "w") as writer:
            for info in base.infolist():
                writer.writestr(info, base.read(info))
            writer.write(rotated, "word/media/rotated.mp4")
        result, events = self.run_compress(package, {"image": False})
        self.assertEqual(result["replaced"], 1)
        self.assertTrue(any(event["type"] == "progress" for event in events) or result["files"][0]["seconds"] < 2)
        with zipfile.ZipFile(result["target"]) as archive:
            output = self.directory / "out.mp4"
            output.write_bytes(archive.read("word/media/rotated.mp4"))
        info = media_compress.probe_video(ffmpeg, output)
        self.assertEqual(media_compress.display_size(info), (360, 640))
        self.assertEqual(info["rotation"], 90)

    def test_odd_sized_video_is_kept(self) -> None:
        ffmpeg = media_compress.find_ffmpeg()
        if ffmpeg is None:
            self.skipTest("没有 ffmpeg")
        clip = self.directory / "odd.mp4"
        subprocess.run(
            [ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=1",
             "-vf", "format=yuv444p,crop=639:359", "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv444p", str(clip)],
            check=True,
        )
        package = self.directory / "奇数.docx"
        with zipfile.ZipFile(self.source) as base, zipfile.ZipFile(package, "w") as writer:
            for info in base.infolist():
                writer.writestr(info, base.read(info))
            writer.write(clip, "word/media/odd.mp4")
        result, _ = self.run_compress(package, {"image": False})
        self.assertEqual(result["replaced"], 0)
        self.assertIsNone(result["target"])
        self.assertIn("奇数", result["files"][0]["reason"])


if __name__ == "__main__":
    unittest.main()
