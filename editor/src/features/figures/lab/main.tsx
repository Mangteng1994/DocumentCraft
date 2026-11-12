/**
 * 配图样张页：渲染全部样张规格，显示排版报告。开发时用 Vite 打开 /figure-lab.html。
 * 地址带 ?export 时，全部排版完成后把每张图导出为 PNG data URL，写进 #figure-exports，
 * 供无头浏览器 --dump-dom 取出另存。
 */

import { createRef, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../styles/tokens.css";
import "./lab.css";
import { FigureView, type FigureReport } from "../FigureView";
import { figureToPng } from "../exportFigure";
import { sampleFigures } from "../samples";
import { validateSpec } from "../spec";

const exporting = new URLSearchParams(location.search).has("export");
const only = new URLSearchParams(location.search).get("only");
const figures = sampleFigures.filter((item) => !only || item.name === only);

function Lab() {
  const [reports, setReports] = useState<Record<string, FigureReport>>({});
  const [exported, setExported] = useState<string>("");
  const [roots] = useState(() => Object.fromEntries(
    figures.map(({ name }) => [name, createRef<HTMLDivElement>()]),
  ));

  const record = useCallback((name: string, report: FigureReport) => {
    setReports((current) => ({ ...current, [name]: report }));
  }, []);

  useEffect(() => {
    if (!exporting || Object.keys(reports).length < figures.length) {
      return;
    }
    const timer = window.setTimeout(async () => {
      const result: Record<string, { png: string; report: FigureReport }> = {};
      for (const item of figures) {
        const root = roots[item.name].current;
        if (root) {
          result[item.name] = { png: await figureToPng(root), report: reports[item.name] };
        }
      }
      setExported(JSON.stringify(result));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [reports, roots]);

  return (
    <div className="figure-lab">
      {figures.map((item) => {
        const report = reports[item.name];
        const problems = validateSpec(item.spec);
        const warnings = [...problems, ...(report?.warnings ?? [])];
        return (
          <section key={item.name} className="figure-lab-item">
            <div className="figure-lab-head">{item.name} · {item.spec.title}</div>
            <div className={`figure-lab-report${warnings.length ? " is-warning" : ""}`}>
              {report
                ? `${report.density} · ${report.widthPt.toFixed(0)}×${report.heightPt.toFixed(0)}pt · ${warnings.length ? warnings.join("；") : "放得下"}`
                : "排版中…"}
            </div>
            <div className="figure-lab-frame">
              <FigureView
                spec={item.spec}
                rootRef={roots[item.name]}
                onReport={(value) => record(item.name, value)}
              />
            </div>
          </section>
        );
      })}
      {exporting ? <pre id="figure-exports" hidden>{exported}</pre> : null}
    </div>
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("缺少 #root 容器");
}
createRoot(container).render(<Lab />);
