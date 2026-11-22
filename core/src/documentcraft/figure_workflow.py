"""科研配图的图位规划、分图生成和回插校验。"""

import base64
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from functools import lru_cache
from io import BytesIO
import json
from pathlib import Path
import re
from tempfile import TemporaryDirectory

from PIL import Image

from .ai import AISettings, PLAN_SCHEMA, request_json
from .illustration import (
    ReportBlock, _figure_cues, _plan_payload, _read_report, _report_outline, _validate_placement,
    figure_page, illustrate, source_digest,
)
from .templates import ConversionError

LAYOUTS = {
    "auto": "由原文决定",
    "layers": "分层总体架构",
    "pipeline": "四栏接入与治理",
    "branch": "纵向组织与双支路",
    "sidebar": "纵向主干与场景侧栏",
    "route": "输入—分析—输出路线",
    "lanes": "横向阶段流程",
    "loop": "三栏路线与底部闭环",
}
TONES = "blue teal green sand lilac rose gray"
ICONS = (
    "drone image model location document calendar chart terrain grid bridge warning settings database "
    "chip camera video radar layers shield scan cloud users server network brain branch workflow "
    "search activity gauge worker construction water temperature checklist file-check route"
)
LIMITS = {"depth": 8, "blocks": 90, "children": 12, "across": 6, "links": 20}
WORKERS = 3
PNG_LIMIT = 16_000_000
PIXEL_LIMIT = 30_000_000

# 字段表同时供提示词和校验使用。带星号的字段为必填。
COMMON_FIELDS = {"id": "id"}
CONTAINER_FIELDS = {"children*": "blocks", "gap": "enum:tight normal loose wide"}
STACK_FIELDS = {**CONTAINER_FIELDS, "fill": "bool"}
HEADING_FIELDS = {"title": "text:24", "subtitle": "text:32"}
TONE_FIELD = {"tone": f"enum:{TONES}"}
BLOCK_FIELDS = {
    "row": {**CONTAINER_FIELDS, "weights": "weights", "stretch": "bool"},
    "column": STACK_FIELDS,
    "grid": {**CONTAINER_FIELDS, "columns*": "columns"},
    "chain": {
        "children*": "blocks", "direction*": "enum:down right", "labels": "labels",
        "evidence*": "quotes", "fill": "bool",
    },
    "panel": {
        **STACK_FIELDS, **HEADING_FIELDS, "tone*": TONE_FIELD["tone"],
        "header": "enum:band side plain none",
    },
    "group": {**STACK_FIELDS, **HEADING_FIELDS},
    "card": {
        **TONE_FIELD, "title*": "text:32", "detail": "detail", "icon": f"enum:{ICONS}",
        "tags": "tags", "variant": "enum:filled outline banner note label",
    },
    "decision": {**TONE_FIELD, "text*": "text:16"},
    "arrow": {
        "direction*": "enum:up down left right", "style": "enum:solid hollow open", "label": "text:12",
        "evidence*": "text:220",
    },
}
LINK_FIELDS = {
    "from*": "id", "to*": "id",
    "fromSide": "enum:top bottom left right", "toSide": "enum:top bottom left right",
    "fromAt": "ratio", "toAt": "ratio", "style": "enum:flow primary dashed marker",
    "both": "bool", "label": "text:12", "evidence*": "text:220",
}


@lru_cache(maxsize=1)
def _guide() -> dict[str, str]:
    guide = Path(__file__).with_name("figure_skill.md").read_text(encoding="utf-8")
    return dict(re.findall(r"^## (.+?)\n\n(.*?)(?=^## |\Z)", guide, re.M | re.S))


def _spec_instructions(section: str) -> str:
    guide = _guide()
    vocabulary = {
        "组件": BLOCK_FIELDS, "通用字段": COMMON_FIELDS, "连线": LINK_FIELDS, "上限": LIMITS,
    }
    definitions = json.dumps(vocabulary, ensure_ascii=False)
    return (
        f"{guide[section]}\n{guide['版式示例']}\n"
        "组件和连线是 JSON 对象。组件另有必填 kind，取组件表的键。字段名末尾星号表示必填，"
        "键名不带星号。blocks 为非空组件数组，weights 为非箭头子项对应的 1–8 整数比例数组，"
        "columns 为 1–6 的整数，ratio 为 0–1 的数字，bool 为布尔值。"
        "id 使用字母、数字、下划线或连字符，首字符为字母。enum 只取冒号后列出的一项。"
        "detail 为最多 42 字的字符串，或最多三条这样的说明。tags 最多三项，每项最多 12 字。"
        "labels 可用 null 跳过，数组长度为子项数减一，其余每项最多 12 字。"
        "箭头和连线的 evidence 是可核对该关系的逐字引文。chain 的 evidence（quotes）是引文数组，"
        "每对相邻子项按顺序各填一条，单条最多 220 字。引文只供校验，不显示在图中。\n"
        f"{definitions}"
    )


def _plan_schema() -> dict:
    diagram_schema = PLAN_SCHEMA["properties"]["diagrams"]["items"]
    properties = {key: value for key, value in diagram_schema["properties"].items() if key not in {"nodes", "edges"}}
    properties["layout"] = {"type": "string", "enum": list(LAYOUTS)}
    diagrams = {
        "type": "array",
        "items": {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False},
    }
    return {**PLAN_SCHEMA, "properties": {**PLAN_SCHEMA["properties"], "diagrams": diagrams}}


def validate_plan(value: object) -> dict:
    """验证计划容器。单图位置错误由调用方逐张记录。"""
    keys = ("diagrams", "covered", "issues", "omissions")
    if not isinstance(value, dict) or any(not isinstance(value.get(key), list) for key in keys):
        raise ConversionError("图位计划缺少候选、实图、遗漏或问题清单。")
    return {key: value[key] for key in keys}


def _check_placement(diagram: object, blocks: list[ReportBlock], cues: dict[int, str]) -> None:
    try:
        problem = _validate_placement(diagram, blocks, cues)
        if diagram["layout"] not in LAYOUTS:
            problem = problem or "未知的版式建议。"
    except (AttributeError, KeyError, TypeError) as error:
        raise ConversionError("图位字段不完整或类型有误。") from error
    if problem:
        raise ConversionError(problem)


def _evidence(diagram: dict, blocks: list[ReportBlock]) -> list[dict]:
    indexes = set()
    for region in diagram["evidence_ranges"]:
        indexes.update(range(region["start"], region["end"] + 1))
    return [{"id": index, "text": blocks[index - 1].text} for index in sorted(indexes) if blocks[index - 1].text.strip()]


def _normalized(text: str) -> str:
    return re.sub(r"\s+", "", text)


def _fields(value: object, fields: dict, location: str) -> dict:
    if not isinstance(value, dict):
        raise ConversionError(f"{location}须为对象。")
    required = {key[:-1] for key in fields if key.endswith("*")}
    allowed = {key.rstrip("*") for key in fields}
    missing = sorted(required.difference(value))
    extra = sorted(value.keys() - allowed)
    if missing or extra:
        detail = []
        if missing:
            detail.append(f"缺少必填 {missing}")
        if extra:
            detail.append(f"多余 {extra}")
        raise ConversionError(f"{location}字段不符：{'，'.join(detail)}。可用 {sorted(allowed)}。")
    return value


class SpecValidator:
    """逐项检查组件、连线和取证范围内的可见文字。"""

    def __init__(self, evidence: list[dict]):
        self.evidence = [_normalized(item["text"]) for item in evidence]
        self.ids: dict[str, tuple[int, ...]] = {}
        self.blocks = 0
        self.leaves = 0

    def text(self, value: object, limit: int, location: str) -> None:
        if not isinstance(value, str) or not value.strip() or len(value) > limit or re.search(r"[\r\n\x00-\x1f]", value):
            raise ConversionError(f"{location}须为不超过 {limit} 字的单行文字。")
        if not any(_normalized(value) in excerpt for excerpt in self.evidence):
            raise ConversionError(f"{location}「{value}」在取证段落中找不到逐字原文。")

    def fields(self, value: dict, fields: dict, location: str) -> None:
        for key, rule in fields.items():
            name = key.rstrip("*")
            if name not in value or rule == "blocks":
                continue
            item = value[name]
            field = f"{location}.{name}"
            if rule.startswith("text:"):
                self.text(item, int(rule.split(":")[1]), field)
            elif rule in {"detail", "tags", "labels", "quotes"}:
                values = [item] if rule == "detail" and isinstance(item, str) else item
                limits = {"detail": (3, 42), "tags": (3, 12), "labels": (LIMITS["children"] - 1, 12),
                          "quotes": (LIMITS["children"] - 1, 220)}
                count, length = limits[rule]
                if not isinstance(values, list) or len(values) > count:
                    raise ConversionError(f"{field}须为最多 {count} 项的列表。")
                for entry in values:
                    if rule != "labels" or entry is not None:
                        self.text(entry, length, field)
            else:
                self.scalar(item, rule, field)

    @staticmethod
    def scalar(item: object, rule: str, field: str) -> None:
        if rule.startswith("enum:"):
            valid = isinstance(item, str) and item in rule[5:].split()
        elif rule == "bool":
            valid = type(item) is bool
        elif rule == "id":
            valid = isinstance(item, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,39}", item)
        elif rule == "columns":
            valid = type(item) is int and 1 <= item <= LIMITS["across"]
        elif rule == "ratio":
            valid = type(item) in (int, float) and 0 <= item <= 1
        else:
            valid = isinstance(item, list) and all(type(number) is int and 1 <= number <= 8 for number in item)
        if not valid:
            raise ConversionError(f"{field}超出允许的值域（{rule}）。")

    def block(self, value: object, path: tuple[int, ...] = (), parent: str = "") -> None:
        self.blocks += 1
        if self.blocks > LIMITS["blocks"] or len(path) >= LIMITS["depth"]:
            raise ConversionError("组件数量或嵌套层数超限。")
        kind = value.get("kind") if isinstance(value, dict) else None
        if not isinstance(kind, str) or kind not in BLOCK_FIELDS:
            raise ConversionError("规格包含未知组件。")
        name = value.get("id")
        location = f"{kind} {name}" if isinstance(name, str) else kind
        fields = {**COMMON_FIELDS, **BLOCK_FIELDS[kind]}
        _fields(value, {"kind*": "", **fields}, location)
        self.fields(value, fields, location)
        if name is not None:
            if name in self.ids:
                raise ConversionError(f"组件 ID 重复：{name}。")
            self.ids[name] = path
        if kind == "arrow":
            horizontal = value["direction"] in {"left", "right"}
            allowed = parent == "row" if horizontal else parent in {"column", "panel", "group"}
            if not allowed:
                raise ConversionError("版式箭头必须沿父容器的排列方向放置。")
        if kind in {"card", "decision"}:
            self.leaves += 1
        if kind == "panel" and value.get("header", "band") != "none" and "title" not in value:
            raise ConversionError("带标题栏的面板须提供标题。")
        if "subtitle" in value and "title" not in value:
            raise ConversionError("副标题须与标题一起使用。")
        if "children*" not in fields:
            return
        children = value["children"]
        if not isinstance(children, list) or not 1 <= len(children) <= LIMITS["children"]:
            raise ConversionError(f"{location}的子组件数量超限或为空。")
        for index, child in enumerate(children):
            self.block(child, (*path, index), kind)
        non_arrows = sum(child["kind"] != "arrow" for child in children)
        horizontal = kind == "row" or (kind == "chain" and value["direction"] == "right")
        if horizontal and non_arrows > LIMITS["across"]:
            raise ConversionError("同一行放不下这么多组件，请拆成多层。")
        if "weights" in value and len(value["weights"]) != non_arrows:
            raise ConversionError("行宽比例数量须等于非箭头子项数。")
        if "labels" in value and len(value["labels"]) != len(children) - 1:
            raise ConversionError("顺序链的标签数须等于相邻连接数。")
        if kind == "chain" and (len(children) < 2 or len(value["evidence"]) != len(children) - 1):
            raise ConversionError("顺序链须有两个以上子项，并为每对相邻子项提供逐字引文。")
        for index, child in enumerate(children):
            if child["kind"] != "arrow":
                continue
            if index == 0 or index == len(children) - 1 or children[index - 1]["kind"] == "arrow":
                raise ConversionError("版式箭头须放在两个组件之间。")

    def links(self, value: object) -> None:
        if not isinstance(value, list) or len(value) > LIMITS["links"]:
            raise ConversionError("连线数量超限或格式错误。")
        seen = set()
        for link in value:
            _fields(link, LINK_FIELDS, "连线")
            self.fields(link, LINK_FIELDS, "连线")
            pair = (link["from"], link["to"])
            start, end = (self.ids.get(item) for item in pair)
            if start is None or end is None:
                raise ConversionError("连线引用了不存在的组件 ID。")
            if start[:len(end)] == end or end[:len(start)] == start:
                raise ConversionError("连线两端不能是同一组件或彼此包含的组件。")
            key = pair
            if link.get("style") == "marker":
                key = (*pair, link.get("fromAt", 0.5), link.get("toAt", 0.5))
            if key in seen:
                raise ConversionError("两组件之间有重复连线。")
            seen.add(key)


def validate_spec(value: object, evidence: list[dict], title: str, width: float) -> dict:
    """校验模型或用户的图规格，图题与宽度由程序注入。"""
    spec = _fields(value, {"root*": "", "links": "", "title": "", "width": ""}, "图规格")
    validator = SpecValidator(evidence)
    validator.block(spec["root"])
    validator.links(spec.get("links", []))
    if validator.leaves < 2:
        raise ConversionError("一张图至少需要两个有取证依据的卡片或判断。")
    return {**spec, "title": title, "width": width}


def _stage_model(settings: AISettings, options: dict, stage: str) -> AISettings:
    model = options.get(stage)
    if isinstance(model, str) and model.strip() and model.strip() != settings.model:
        # 已保存的推理档位针对默认模型，切换模型后使用它自己的默认档位。
        return replace(settings, model=model.strip(), reasoning_effort="")
    return settings


def _generate(settings: AISettings, context: dict, title: str, width: float) -> dict:
    instructions = _spec_instructions("单图生成")
    for attempt in range(2):
        try:
            spec = request_json(settings, instructions, context)
            return validate_spec(spec, context["evidence"], title, width)
        except (ConversionError, TimeoutError) as error:
            if attempt == 1:
                raise
            context = {**context, "validation_error": str(error)}
    raise AssertionError("单图生成重试循环未返回。")


def plan_figures(source: Path, settings: AISettings, options: dict) -> dict:
    """读取报告、规划图位并并行生成组件树，每张图的失败单独返回。"""
    source = source.resolve(strict=True)
    digest = source_digest(source)
    with TemporaryDirectory(prefix="documentcraft-figures-") as folder:
        _, _, document, blocks = _read_report(source, Path(folder))
        if not blocks:
            raise ConversionError("报告没有可分析的正文。")
        if source_digest(source) != digest:
            raise ConversionError("读取期间源报告已变动，请重新分析。")
        cues = _figure_cues(blocks)
        payload = _plan_payload(blocks, cues, _report_outline(blocks))
        guide = _guide()
        instructions = f"{guide['规划']}\n{guide['版式示例']}\nJSON Schema:\n"
        instructions += json.dumps(_plan_schema(), ensure_ascii=False)
        plan = validate_plan(request_json(_stage_model(settings, options, "plannerModel"), instructions, payload))
        generator = _stage_model(settings, options, "figureModel")

        def generate_candidate(item: tuple[int, dict]) -> dict:
            index, diagram = item
            candidate = {"id": index, "diagram": diagram}
            try:
                _check_placement(diagram, blocks, cues)
                anchor = blocks[diagram["anchor"] - 1]
                width, height = figure_page(document, anchor.anchor)
                candidate.update({"width": width, "height": height, "anchorText": anchor.text[:300]})
                context = _context(diagram, blocks, width, height, diagram["layout"])
                candidate["evidencePreview"] = [
                    {"id": item["id"], "text": item["text"][:300]} for item in context["evidence"][:8]
                ]
                candidate["spec"] = _generate(generator, context, diagram["title"], width)
            except (ConversionError, OSError, ValueError) as error:
                candidate["error"] = str(error)
            return candidate

        with ThreadPoolExecutor(max_workers=WORKERS) as executor:
            candidates = list(executor.map(generate_candidate, enumerate(plan["diagrams"], 1)))
    if source_digest(source) != digest:
        raise ConversionError("分析期间源报告已变动，请重新分析。")
    return {"digest": digest, "plan": plan, "candidates": candidates}


def _context(diagram: dict, blocks: list[ReportBlock], width: float, height: float, layout: str) -> dict:
    return {
        "title": diagram["title"], "type": diagram["type"], "layout": layout, "layout_name": LAYOUTS[layout],
        "width_pt": width, "max_height_pt": height, "evidence": _evidence(diagram, blocks),
    }


def refine_figure(source: Path, settings: AISettings | None, action: str, payload: dict) -> dict:
    """按原始图位校验手动修改、重新生成或视觉复核单张图。"""
    source = source.resolve(strict=True)
    digest = payload.get("digest")
    if digest != source_digest(source):
        raise ConversionError("源报告已变动，请重新分析。")
    with TemporaryDirectory(prefix="documentcraft-figures-") as folder:
        _, _, document, blocks = _read_report(source, Path(folder))
        diagram = payload.get("diagram")
        _check_placement(diagram, blocks, _figure_cues(blocks))
        width, height = figure_page(document, blocks[diagram["anchor"] - 1].anchor)
    if source_digest(source) != digest:
        raise ConversionError("读取期间源报告已变动，请重新分析。")
    layout = payload.get("layout", diagram["layout"])
    if not isinstance(layout, str) or layout not in LAYOUTS:
        raise ConversionError("未知的图示版式。")
    context = _context(diagram, blocks, width, height, layout)
    previous = payload.get("spec")
    title = diagram["title"]
    if action == "validate":
        return {"spec": validate_spec(previous, context["evidence"], title, width)}
    if previous is not None:
        context["previous"] = validate_spec(previous, context["evidence"], title, width)
    if settings is None:
        raise ConversionError("缺少 AI 连接设置。")
    if action == "review":
        png = payload.get("png")
        _png_bytes(png, width, height)
        model = _stage_model(settings, payload, "reviewModel")
        response = request_json(model, _spec_instructions("视觉复核"), context, image=png)
        if response.get("status") == "pass":
            return {"status": "pass"}
        reason = response.get("reason")
        if response.get("status") != "revise" or not isinstance(reason, str) or not reason.strip():
            raise ConversionError("视觉复核没有返回有效的结论。")
        spec = validate_spec(response.get("spec"), context["evidence"], title, width)
        return {"status": "revise", "spec": spec, "reason": reason[:300]}
    feedback = payload.get("feedback")
    if isinstance(feedback, str) and feedback.strip():
        context["layout_feedback"] = feedback[:1200]
    model = _stage_model(settings, payload, "figureModel")
    return {"spec": _generate(model, context, title, width)}


def _png_bytes(value: object, width: float, height: float) -> tuple[bytes, int]:
    prefix = "data:image/png;base64,"
    if not isinstance(value, str) or not value.startswith(prefix) or len(value) > PNG_LIMIT:
        raise ConversionError("缺少有效 PNG，或图片体积超限。")
    try:
        data = base64.b64decode(value[len(prefix):], validate=True)
        with Image.open(BytesIO(data), formats=["PNG"]) as image:
            pixels = image.width * image.height
            if image.n_frames != 1 or not 300 <= image.width * 72 / width <= 450 or pixels > PIXEL_LIMIT:
                raise ConversionError("图片分辨率不符合印刷要求。")
            if image.height * width / image.width > height + 1:
                raise ConversionError("图片超出页面可用高度。")
            dpi = round(image.width * 72 / width)
            image.verify()
    except (OSError, ValueError, Image.DecompressionBombError) as error:
        raise ConversionError("PNG 无法读取。") from error
    return data, dpi


def write_approved_png(
    entry: object, output: Path, diagram: dict, blocks: list[ReportBlock], width: float, height: float,
) -> None:
    """重新核对已确认的规格和 PNG，并按实际印刷分辨率保存。"""
    entry = _fields(entry, {"spec*": "", "png*": ""}, "已确认配图")
    spec = validate_spec(entry["spec"], _evidence(diagram, blocks), diagram["title"], width)
    data, dpi = _png_bytes(entry["png"], width, height)
    with Image.open(BytesIO(data), formats=["PNG"]) as image:
        image.save(output, format="PNG", dpi=(dpi, dpi))
    # 规格与图片放在同一资源目录，之后可以原样重新排版或复现版面问题，不必从图片倒推。
    output.with_suffix(".json").write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8")


def commit_figures(source: Path, payload: dict) -> dict:
    """只把已确认的图写入新报告，同时生成审核清单。"""
    return illustrate(source, None, colored=False, prepared=payload)
