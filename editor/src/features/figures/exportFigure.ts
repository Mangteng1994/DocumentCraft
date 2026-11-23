/**
 * 把渲染好的配图导出为 PNG。
 *
 * 做法是把图的 DOM（连同内嵌样式表）序列化进 SVG foreignObject，作为图片画到 canvas 上再取 PNG。
 * 图里不能引用外部资源（网络字体、外链图片），否则浏览器会拒绝从 canvas 取数据；字体只用系统字体。
 */

import { figureTokens } from "../../styles/tokens";

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("配图无法栅格化。"));
    image.src = url;
  });
}

/** 栅格化时额外给出的画布高度比例，用来量出图在 SVG 内重新排版后的真实高度。 */
const MEASURE_SLACK = 1.5;
/** 栅格化后的高度允许比页面中测得的高度多出的 CSS 像素，更多视为栅格化排版与页面排版不一致。 */
const HEIGHT_TOLERANCE_PX = 2;
/** 测量用的底色。图的根节点自带纸色背景，不会出现这种颜色，所以没被画到的行就是根节点以下的空白。 */
const SENTINEL = "#ff00ff";

/**
 * 量出图在栅格化时重新排版后的高度（CSS 像素）。
 * 栅格化是把序列化的 DOM 放进独立的 SVG 文档里重新排版，字体度量和换行可能与页面不同。
 * 此时按页面高度截取会把底部内容切掉，且连线是按页面排版算出的位置，也会与卡片错位，所以必须检出。
 */
function renderedHeight(canvas: HTMLCanvasElement, scale: number): number {
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("无法检查配图导出结果。");
  }
  const columns = 16;
  const { width, height } = canvas;
  for (let row = height - 1; row >= 0; row -= 1) {
    const { data } = context.getImageData(0, row, width, 1);
    for (let column = 0; column < columns; column += 1) {
      const index = Math.floor(((column + 0.5) / columns) * width) * 4;
      // 哨兵色的绿色分量为 0，纸色及图中的任何颜色都远大于此。
      if (data[index + 1] > 128) {
        return (row + 1) / scale;
      }
    }
  }
  return 0;
}

/** 返回 PNG 的 data URL。scale 为每 CSS 像素对应的图像像素。 */
export async function figureToPng(root: HTMLElement, scale: number = figureTokens.exportScale): Promise<string> {
  const width = root.offsetWidth;
  const height = root.offsetHeight;
  const tall = Math.ceil(height * MEASURE_SLACK);
  const markup = new XMLSerializer().serializeToString(root);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${tall}">`,
    `<foreignObject x="0" y="0" width="${width}" height="${tall}">${markup}</foreignObject>`,
    "</svg>",
  ].join("");
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const image = await loadImage(url);
  const measure = document.createElement("canvas");
  measure.width = Math.round(width * scale);
  measure.height = Math.round(tall * scale);
  const measureContext = measure.getContext("2d", { willReadFrequently: true });
  if (!measureContext) {
    throw new Error("无法创建画布。");
  }
  measureContext.fillStyle = SENTINEL;
  measureContext.fillRect(0, 0, measure.width, measure.height);
  measureContext.scale(scale, scale);
  measureContext.drawImage(image, 0, 0, width, tall);
  const rendered = renderedHeight(measure, scale);
  if (rendered > height + HEIGHT_TOLERANCE_PX) {
    const extra = Math.round((rendered - height) / figureTokens.pxPerPt);
    throw new Error(
      `配图栅格化后比排版时高约 ${extra}pt，底部内容会被截断。请减少文字、合并卡片或减少层数`,
    );
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("无法创建画布。");
  }
  context.fillStyle = figureTokens.paper;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.scale(scale, scale);
  context.drawImage(image, 0, 0, width, tall);

  // WebView 可能成功加载 SVG 却没有栅格化其内容，先检查缩略采样是否全白。
  const sample = document.createElement("canvas");
  sample.width = 48;
  sample.height = 48;
  const probe = sample.getContext("2d");
  if (!probe) {
    throw new Error("无法检查配图导出结果。");
  }
  probe.drawImage(canvas, 0, 0, sample.width, sample.height);
  const { data } = probe.getImageData(0, 0, sample.width, sample.height);
  const hasInk = data.some((value, index) => index % 4 !== 3 && value < 250);
  if (!hasInk) {
    throw new Error("配图导出为空白。");
  }
  const png = canvas.toDataURL("image/png");
  if (!png.startsWith("data:image/png;base64,")) {
    throw new Error("配图无法导出为 PNG。");
  }
  return png;
}
