/**
 * 样张规格：按用户提供的 7 张参考图手写，用来对照验证组件库和渲染器，
 * 也作为以后提示词里「好图长什么样」的示例。
 */

import type { FigureTone } from "../../styles/tokens";
import type { Block, CardBlock, FigureSpec } from "./spec";

function card(title: string, detail?: string | string[], extra: Partial<CardBlock> = {}): CardBlock {
  return { kind: "card", title, detail, ...extra };
}

function cards(titles: string[]): Block[] {
  return titles.map((title) => card(title));
}

/** 图 1：分层架构，左侧竖栏标题，中部三栏，上下箭头连接各层。 */
const layered: FigureSpec = {
  title: "数智化管控总体架构",
  root: {
    kind: "column",
    gap: "loose",
    children: [
      {
        kind: "panel", tone: "blue", header: "side", title: "数智化管控闭环",
        children: [
          { kind: "chain", direction: "right", children: cards(["数据采集", "智能分析", "人工复核", "处置反馈"]) },
          card("形成数据采集、智能分析、人工复核及处置反馈相衔接的数智化管控体系", undefined, { variant: "note" }),
        ],
      },
      {
        kind: "panel", tone: "teal", header: "side", title: "场景能力输出",
        children: [{
          kind: "row",
          children: [
            card("现场状态识别", undefined, { id: "o1" }),
            card("异常关联分析", undefined, { id: "o2" }),
            card("证据汇集", undefined, { id: "o3" }),
            card("业务辅助研判", undefined, { id: "o4" }),
          ],
        }],
      },
      {
        kind: "panel", id: "core", tone: "sand", header: "none",
        children: [{
          kind: "row",
          weights: [1.05, 2.3, 0.95],
          children: [
            {
              kind: "panel", tone: "sand", header: "plain", title: "AI智能底座", gap: "tight",
              children: [
                "模型服务接入与治理", "文档解析能力", "工程知识资产管理与检索", "长期记忆与记忆治理",
                "AI运行任务管理", "规则与模型编排能力", "人工复核支撑能力", "模型运行评估与配置管理",
                "安全审计与权限管理", "算力与模型服务调用", "智能体模型与服务接入", "统一会话与场景应用支撑",
              ].map((title) => card(title, undefined, { variant: "outline" })),
            },
            { kind: "arrow", direction: "right", label: "能力支撑" },
            {
              kind: "panel", tone: "sand", header: "plain", title: "4个核心场景应用",
              children: [{
                kind: "grid", columns: 2,
                children: [
                  card("关键控制性工点施工进度智能核验与动态纠偏", undefined, { tags: ["进度核验", "偏差分析", "动态纠偏"] }),
                  card("基于多源时空数据的隧道施工状态智能研判", undefined, { tags: ["状态还原", "异常关联", "智能研判"] }),
                  card("路基高边坡与隧道洞口边仰坡稳定性趋势研判", undefined, { tags: ["趋势识别", "多源关联", "异常区段识别"] }),
                  card("泥石流事件监测预警", "多传感器融合与智能体协同", { tags: ["分级提醒", "独立规则报警"] }),
                ],
              }],
            },
            { kind: "arrow", direction: "right", label: "验证评估与优化" },
            {
              kind: "panel", tone: "sand", header: "plain", title: "应用验证与运行评估机制", fill: true,
              children: cards(["场景测试", "指标核验", "运行评估", "反馈优化"]),
            },
          ],
        }],
      },
      {
        kind: "panel", tone: "lilac", header: "side", title: "基础支撑与数据来源",
        children: [{
          kind: "row",
          children: [
            card("工程数据中心", undefined, { id: "b1" }),
            card("BIM+GIS平台", undefined, { id: "b2" }),
            card("IoT感知平台", undefined, { id: "b3" }),
            card("相关专业系统", undefined, { id: "b4" }),
          ],
        }],
      },
    ],
  },
  links: [
    { from: "core", to: "o1" }, { from: "core", to: "o2" }, { from: "core", to: "o3" }, { from: "core", to: "o4" },
    { from: "b1", to: "core" }, { from: "b2", to: "core" }, { from: "b3", to: "core" }, { from: "b4", to: "core" },
  ],
};

/** 图 2：四栏流程，左右两栏的卡片逐个连到中间面板。 */
const pipeline: FigureSpec = {
  title: "模型服务统一接入与调用",
  root: {
    kind: "row",
    gap: "wide",
    children: [
      {
        kind: "panel", tone: "blue", title: "模型来源", fill: true,
        children: [
          card("集团内部模型服务", "交融大模型、思路智云等", { id: "s1" }),
          card("国产商用模型服务", "经项目确认后补充接入", { id: "s2" }),
          card("OCR及视觉模型服务", "文档识别、图像理解等", { id: "s3" }),
          card("专业算法服务", "影像识别、数据分析等", { id: "s4" }),
        ],
      },
      {
        kind: "panel", id: "gov", tone: "teal", title: "统一接入与治理",
        children: [{
          kind: "chain", direction: "down", fill: true,
          children: [
            card("接口适配与服务封装", "标准接口适配、服务封装"),
            card("统一鉴权管理", "身份认证、权限控制"),
            card("服务路由", "按模型类型及场景需求路由"),
            card("调用监控", "运行状态监测、调用统计"),
            card("异常处理", "调用异常、失败处理"),
          ],
        }],
      },
      {
        kind: "panel", id: "ctrl", tone: "sand", title: "调用控制",
        children: [{
          kind: "chain", direction: "down", fill: true,
          children: [
            card("按场景配置调用流程", "根据任务类型组织模型服务"),
            card("数据安全约束", ["本地数据边界控制", "受限资料仅使用集团内部模型"]),
            card("模型服务组合调用", "支持多模型、多工具协同"),
            card("调用状态管理", "状态监控、告警、异常处理"),
          ],
        }],
      },
      {
        kind: "panel", tone: "lilac", title: "场景支撑", fill: true,
        children: [
          card("施工进度核验", ["航拍影像理解、施工活动识别", "结构化信息提取"], { id: "t1" }),
          card("隧道施工状态研判", ["掌子面照片、现场视频分析", "辅助解释"], { id: "t2" }),
          card("边坡变形趋势分析", ["分析结果辅助理解", "相关证据整理"], { id: "t3" }),
          card("泥石流监测预警", ["监测结果辅助说明", "事件证据整理"], { id: "t4" }),
        ],
      },
    ],
  },
  links: [
    { from: "s1", to: "gov" }, { from: "s2", to: "gov" }, { from: "s3", to: "gov" }, { from: "s4", to: "gov" },
    { from: "gov", to: "ctrl", style: "primary" },
    { from: "ctrl", to: "t1" }, { from: "ctrl", to: "t2" }, { from: "ctrl", to: "t3" }, { from: "ctrl", to: "t4" },
  ],
};

/** 图 3：自上而下的组织结构，一个来源分到两个下游面板。 */
const memory: FigureSpec = {
  title: "长期记忆组织与应用",
  root: {
    kind: "column",
    gap: "wide",
    children: [
      card("知识来源", undefined, { id: "src", tone: "blue", variant: "banner" }),
      {
        kind: "panel", id: "store", tone: "teal", title: "长期记忆存储与组织",
        children: [{
          kind: "row",
          children: [
            card("工程对象组织", ["项目、标段、桩号、构件", "隧道、边坡、监测点等"]),
            card("业务场景组织", ["施工进度、隧道施工", "边坡稳定、泥石流监测等"]),
            card("时间组织", ["发生时间、分析时间", "形成时间等"]),
            card("知识索引管理", ["关键词、语义索引", "关联信息等"]),
          ],
        }],
      },
      {
        kind: "row",
        gap: "loose",
        children: [
          {
            kind: "panel", id: "recall", tone: "sand", title: "记忆召回与应用",
            children: [{
              kind: "row",
              children: [
                card("任务上下文匹配", ["识别工程对象", "匹配相关记忆"], { tone: "green" }),
                card("相关信息召回", ["历史状态", "相关分析结论", "相关技术资料"], { tone: "rose" }),
                card("辅助分析应用", ["为大模型分析", "提供参考信息"]),
              ],
            }],
          },
          {
            kind: "panel", id: "care", tone: "lilac", title: "记忆治理与维护",
            children: [{
              kind: "row",
              children: [
                card("内容更新与修正", ["根据最新情况", "更新和修正"], { tone: "blue" }),
                card("版本管理", ["保留历史版本", "记录修订过程"], { tone: "blue" }),
                card("权限与隔离", ["按项目/场景隔离", "权限控制"], { tone: "blue" }),
              ],
            }],
          },
        ],
      },
    ],
  },
  links: [
    { from: "src", to: "store" },
    { from: "store", to: "recall" },
    { from: "store", to: "care" },
  ],
};

/** 图 4：主干自上而下，右侧是被调用的场景侧栏。 */
const trunk: FigureSpec = {
  title: "统一入口与分析调用流程",
  root: {
    kind: "row",
    gap: "wide",
    weights: [3.6, 1],
    children: [
      {
        kind: "column",
        gap: "tight",
        children: [
          {
            kind: "panel", tone: "blue", title: "统一入口",
            children: [{ kind: "chain", direction: "right", children: cards(["项目统一门户", "AI会话入口", "智能分析任务入口"]) }],
          },
          { kind: "arrow", direction: "down" },
          {
            kind: "panel", id: "cap", tone: "sand", title: "底座能力调用",
            children: [{ kind: "row", children: cards(["知识检索", "记忆召回", "模型推理", "专业工具调用", "任务执行"]) }],
          },
          { kind: "arrow", direction: "down" },
          {
            kind: "panel", tone: "lilac", title: "分析结果组织",
            children: [{
              kind: "row",
              children: [
                card("工程对象关联", "桩号、BIM构件、WBS、监测点"),
                card("结构化分析结果", "分析结论、异常线索、任务结果"),
                card("关联原始证据", "施工记录、监测数据、图像视频"),
              ],
            }],
          },
          { kind: "arrow", direction: "down" },
          {
            kind: "panel", tone: "green", title: "业务应用与反馈",
            children: [{
              kind: "row",
              children: [
                card("BIM+GIS定位展示", "按工程对象关联展示"),
                card("业务系统查询", "授权访问与结果查看"),
                card("人工复核", "原始证据核查与确认"),
                card("任务处置与结果归集", "反馈记录与业务闭环"),
              ],
            }],
          },
        ],
      },
      {
        kind: "panel", id: "scenes", tone: "teal", title: "四个AI应用场景", fill: true,
        children: [
          card("施工进度智能核验", "影像识别与进度分析任务支撑"),
          card("隧道施工状态研判", "工序状态与异常分析辅助研判"),
          card("边坡变形趋势研判", "趋势分析与巡检核查辅助研判"),
          card("泥石流事件监测预警", "监测事件与证据汇集辅助处置"),
        ],
      },
    ],
  },
  links: [{ from: "cap", to: "scenes", style: "primary" }],
};

/** 图 5：输入、处理、输出三段，处理区内有虚线分组与分叉汇合。 */
const progress: FigureSpec = {
  title: "施工进度智能核验技术路线",
  root: {
    kind: "row",
    gap: "tight",
    weights: [1.05, 3, 1.15],
    children: [
      {
        kind: "panel", tone: "blue", title: "数据输入", fill: true,
        children: [
          card("无人机巡查视频", undefined, { icon: "drone" }),
          card("精细航拍影像", undefined, { icon: "image" }),
          card("BIM模型", undefined, { icon: "model" }),
          card("桩号与工点信息", undefined, { icon: "location" }),
          card("WBS计划", undefined, { icon: "document" }),
          card("施工日历与月周计划", undefined, { icon: "calendar" }),
        ],
      },
      { kind: "arrow", direction: "right", style: "hollow" },
      {
        kind: "panel", tone: "teal", title: "智能分析处理", gap: "loose",
        children: [
          {
            kind: "row",
            gap: "loose",
            children: [
              {
                kind: "group", id: "g1", title: "施工状态识别与重点工点筛选",
                children: [{
                  kind: "chain", direction: "down", fill: true,
                  children: cards(["视频预处理与关键帧提取", "施工阶段与作业活动识别", "跨期状态变化分析", "重点工点筛选"]),
                }],
              },
              {
                kind: "group", id: "g2", title: "实景三维建模与进展量化", gap: "loose",
                children: [
                  card("精细航拍数据处理与三维建模", undefined, { id: "m1" }),
                  {
                    kind: "row",
                    children: [
                      card("多期点云与DEM配准差分", "（路基/边坡/洞口等）", { id: "m2" }),
                      card("桥梁点云与BIM构件匹配", "（墩柱/盖梁/上部结构等）", { id: "m3" }),
                    ],
                  },
                  card("实际进展量化", "（体积、面积、构件形成状态等）", { id: "m4" }),
                ],
              },
            ],
          },
          {
            kind: "group", id: "g3", title: "进度核验与动态纠偏分析",
            children: [{
              kind: "chain", direction: "right",
              children: cards(["实际进度与WBS计划映射", "偏差分析与工期预测", "动态纠偏辅助分析"]),
            }],
          },
        ],
      },
      { kind: "arrow", direction: "right", style: "hollow" },
      {
        kind: "panel", tone: "sand", title: "业务输出", fill: true, gap: "tight",
        children: [
          card("工点施工状态", undefined, { icon: "chart", variant: "outline" }),
          card("土石方变化体积", undefined, { icon: "terrain", variant: "outline" }),
          card("防护施工面积", undefined, { icon: "grid", variant: "outline" }),
          card("桥梁构件形成状态", undefined, { icon: "bridge", variant: "outline" }),
          card("实际与计划偏差清单", undefined, { icon: "document", variant: "outline" }),
          card("节点风险提示", undefined, { icon: "warning", variant: "outline" }),
          card("纠偏任务与复核闭环", undefined, { icon: "settings", variant: "outline" }),
        ],
      },
    ],
  },
  links: [
    { from: "m1", to: "m2" }, { from: "m1", to: "m3" },
    { from: "m2", to: "m4" }, { from: "m3", to: "m4" },
    { from: "g1", to: "g2" },
    { from: "g1", to: "g3" }, { from: "g2", to: "g3" },
  ],
};

function stage(title: string, tone: FigureTone, steps: Block[], labels?: (string | null)[], id?: string): Block {
  return {
    kind: "panel", tone, title, id,
    children: [{ kind: "chain", direction: "down", fill: true, children: steps, labels }],
  };
}

const quantification: Block = {
  kind: "panel", id: "quantity-stage", tone: "lilac", title: "4. 施工进展量化计算",
  children: [{
    kind: "row",
    gap: "tight",
    children: [
      {
        kind: "group", title: "连续表面类工程", subtitle: "（路基/边坡/洞口等）",
        children: [{
          kind: "chain", direction: "down", fill: true,
          children: cards(["提取工程区域点云/DEM", "计算土石方变化体积", "识别防护施工区域", "计算防护施工面积", "输出工程量结果"]),
        }],
      },
      {
        kind: "group", title: "桥梁构件类工程", subtitle: "（墩柱/盖梁/上部结构等）",
        children: [{
          kind: "chain", direction: "down", fill: true,
          children: cards(["实景点云与BIM构件匹配", "构件形成状态识别", "计算构件完成比例", "统计构件形成状态", "输出工程量结果"]),
        }],
      },
    ],
  }],
};

/** 图 6：前半程从左向右、后半程从右向左，量化阶段分两条支线。 */
const stages: FigureSpec = {
  title: "施工进展量化总体流程",
  root: {
    kind: "column",
    gap: "wide",
    children: [
      {
        kind: "row",
        gap: "loose",
        children: [
          stage("1. 日常无人机巡查", "blue", cards([
            "制定巡查航线开展日常巡查", "获取巡查视频", "视频预处理与关键帧提取",
            "施工状态识别", "跨期状态变化分析", "生成重点工点清单",
          ])),
          { kind: "arrow", direction: "right" },
          stage("2. 重点工点筛选与精细航拍", "teal", [
            card("基于识别结果筛选重点工点"), card("下发精细航拍任务"),
            card("无人机精细航拍", undefined, { id: "fly" }), card("影像质量检查"),
            { kind: "decision", id: "check", text: "影像是否合格" }, card("进入三维建模"),
          ], [null, null, null, null, "是"]),
          { kind: "arrow", direction: "right" },
          stage("3. 三维建模与多期数据处理", "sand", cards([
            "空三解算与三维建模（SfM/MVS）", "多期点云/DEM配准", "多期差分计算", "提取变化区域与变化量",
          ]), undefined, "model-stage"),
        ],
      },
      {
        kind: "row",
        gap: "loose",
        weights: [1, 1, 2],
        children: [
          stage("6. 进入进度分析与动态纠偏", "rose", cards([
            "对比基准计划、月计划/周计划", "计算进度偏差与剩余工程量", "预测完成时间、识别节点风险", "生成纠偏建议与复核任务",
          ])),
          { kind: "arrow", direction: "left" },
          stage("5. 成果关联与汇总", "green", cards([
            "关联桩号与工程对象", "匹配BIM构件与WBS任务", "汇总土石方量、防护面积、构件完成状态", "形成工点施工进展量化结果",
          ])),
          { kind: "arrow", direction: "left" },
          quantification,
        ],
      },
    ],
  },
  links: [
    { from: "model-stage", to: "quantity-stage", style: "primary" },
    { from: "check", to: "fly", fromSide: "right", toSide: "right", label: "否" },
  ],
};

/** 图 7：多源输入、四段处理、输出，底部闭环回到输入。 */
const tunnel: FigureSpec = {
  title: "隧道施工状态智能研判技术路线",
  root: {
    kind: "column",
    gap: "wide",
    children: [
      {
        kind: "row",
        gap: "tight",
        weights: [1, 4.2, 1.05],
        children: [
          {
            kind: "panel", id: "in", tone: "blue", title: "多源数据输入", fill: true, gap: "tight",
            children: cards([
              "施工日志与工序进展", "人员定位与考勤", "机械设备运行数据", "视频监控与掌子面影像", "监控量测数据",
              "超前地质预报数据", "环境监测数据（气体、温湿度等）", "工程对象与桩号信息", "BIM模型", "WBS计划与施工日历",
            ]),
          },
          { kind: "arrow", direction: "right", style: "hollow" },
          {
            kind: "panel", id: "proc", tone: "teal", title: "智能分析处理",
            children: [{
              kind: "row",
              gap: "tight",
              children: [
                {
                  kind: "group", title: "数据治理与时空关联",
                  children: [{ kind: "chain", direction: "down", fill: true, children: cards([
                    "数据清洗与质检", "时空基准与同步", "掌子面与区段划分", "桩号与BIM构件映射", "关联WBS任务",
                  ]) }],
                },
                { kind: "arrow", direction: "right", style: "hollow" },
                {
                  kind: "group", title: "施工状态动态还原",
                  children: [{ kind: "chain", direction: "down", fill: true, children: cards([
                    "施工工序状态识别", "多掌子面状态组织", "校核工序转换规则", "施工进度与工序匹配", "施工状态时空分布",
                  ]) }],
                },
                { kind: "arrow", direction: "right", style: "hollow" },
                {
                  kind: "group", title: "异常识别与风险分析",
                  children: [{ kind: "chain", direction: "down", fill: true, children: cards([
                    "人员与机械异常识别", "监控量测异常识别", "环境参数异常识别", "工序衔接异常识别", "多源异常关联分析", "风险等级评估",
                  ]) }],
                },
                { kind: "arrow", direction: "right", style: "hollow" },
                {
                  kind: "group", title: "智能体辅助研判",
                  children: [{ kind: "chain", direction: "down", fill: true, children: cards([
                    "多源证据汇集与分析", "调用专业规则与工具", "异常与待核查事项", "形成分析结论与建议", "推送至管理人员复核",
                  ]) }],
                },
              ],
            }],
          },
          { kind: "arrow", direction: "right", style: "hollow" },
          {
            kind: "panel", id: "out", tone: "sand", title: "业务输出", fill: true,
            children: [
              card("隧道施工状态图", "按掌子面、区段展示"),
              ...cards(["异常事件清单", "风险预警与提示", "待核查事项与证据",
                "施工进度分析结果", "纠偏建议与任务工单", "处置结果与闭环归档"]),
            ],
          },
        ],
      },
      {
        kind: "panel", id: "loop", tone: "lilac", header: "side", title: "反馈与闭环管理",
        children: [{
          kind: "chain", direction: "right",
          children: cards(["现场核查与任务处置", "处置结果反馈", "数据更新与状态修正", "效果复核与风险消除", "形成闭环记录"]),
        }],
      },
    ],
  },
  links: [
    { from: "out", to: "loop" },
    { from: "loop", to: "in" },
    { from: "proc", to: "loop", both: true },
  ],
};

export const sampleFigures: { name: string; spec: FigureSpec }[] = [
  { name: "01-layered", spec: layered },
  { name: "02-pipeline", spec: pipeline },
  { name: "03-memory", spec: memory },
  { name: "04-trunk", spec: trunk },
  { name: "05-progress", spec: progress },
  { name: "06-stages", spec: stages },
  { name: "07-tunnel", spec: tunnel },
];
