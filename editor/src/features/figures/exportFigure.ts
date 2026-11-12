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

/** 返回 PNG 的 data URL。scale 为每 CSS 像素对应的图像像素。 */
export async function figureToPng(root: HTMLElement, scale: number = figureTokens.exportScale): Promise<string> {
  const width = root.offsetWidth;
  const height = root.offsetHeight;
  const markup = new XMLSerializer().serializeToString(root);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<foreignObject x="0" y="0" width="${width}" height="${height}">${markup}</foreignObject>`,
    "</svg>",
  ].join("");
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const image = await loadImage(url);
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
  context.drawImage(image, 0, 0, width, height);

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
