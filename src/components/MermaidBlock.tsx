import { Check, Code2, Copy, Download, Eye, LoaderCircle, Maximize2, Minus, Plus, RotateCcw, X } from "lucide-react";
import { Highlight } from "prism-react-renderer";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ThemeVariant } from "../../shared/contracts/theme";
import { useTheme } from "../theme/ThemeProvider";

type MermaidApi = typeof import("mermaid")["default"];

let mermaidReady: Promise<MermaidApi> | null = null;
let mermaidRenderQueue: Promise<unknown> = Promise.resolve();

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((mod) => mod.default);
  }
  return mermaidReady;
}

function renderMermaid(code: string, domId: string, variant: ThemeVariant): Promise<string> {
  const task = mermaidRenderQueue.then(async () => {
    const mermaid = await loadMermaid();
    const { colors, typography } = variant;
    mermaid.initialize({
      startOnLoad: false,
      theme: "base",
      themeVariables: {
        activationBkgColor: colors.surfaceSubtle,
        activationBorderColor: colors.border,
        actorBkg: colors.surfaceSubtle,
        actorBorder: colors.border,
        actorLineColor: colors.muted,
        actorTextColor: colors.foreground,
        background: "transparent",
        clusterBkg: "transparent",
        clusterBorder: colors.border,
        edgeLabelBackground: colors.surface,
        evenColor: "transparent",
        fontFamily: typography.uiFont,
        fontSize: "14px",
        labelBoxBkgColor: colors.surfaceSubtle,
        labelBoxBorderColor: colors.border,
        labelTextColor: colors.foreground,
        lineColor: colors.muted,
        loopTextColor: colors.foreground,
        mainBkg: colors.surface,
        nodeBorder: colors.border,
        noteBkgColor: colors.surfaceSubtle,
        noteBorderColor: colors.border,
        noteTextColor: colors.foreground,
        oddColor: colors.surfaceSubtle,
        primaryBorderColor: colors.border,
        primaryColor: colors.surface,
        primaryTextColor: colors.foreground,
        secondBkg: colors.surfaceSubtle,
        secondaryColor: colors.surfaceSubtle,
        sequenceNumberColor: colors.foreground,
        signalColor: colors.foreground,
        signalTextColor: colors.foreground,
        tertiaryColor: colors.hover,
        textColor: colors.foreground
      },
      securityLevel: "strict",
      suppressErrorRendering: true,
      flowchart: { useMaxWidth: false, htmlLabels: true, curve: "linear" },
      sequence: { useMaxWidth: false },
      gantt: { useMaxWidth: false }
    });
    await mermaid.parse(code);
    const result = await mermaid.render(domId, code);
    return result.svg;
  });
  mermaidRenderQueue = task.catch(() => undefined);
  return task;
}

type View = "render" | "code";

function normalizeSvgForDisplay(originalSvg: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(originalSvg, "image/svg+xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return originalSvg;
  const svgEl = doc.documentElement as unknown as SVGSVGElement;
  if (svgEl.tagName.toLowerCase() !== "svg") return originalSvg;

  let viewBox = svgEl.getAttribute("viewBox");
  if (!viewBox) {
    const w = parseFloat(svgEl.getAttribute("width") ?? "");
    const h = parseFloat(svgEl.getAttribute("height") ?? "");
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      viewBox = `0 0 ${w} ${h}`;
      svgEl.setAttribute("viewBox", viewBox);
    }
  }
  const vbParts = viewBox?.split(/[\s,]+/).map(Number).filter(Number.isFinite);
  const vbWidth = vbParts && vbParts.length === 4 ? vbParts[2] : 0;

  svgEl.removeAttribute("width");
  svgEl.removeAttribute("height");
  if (vbWidth > 0 && vbWidth < 600) {
    svgEl.setAttribute("width", "100%");
  } else if (vbWidth > 0) {
    svgEl.setAttribute("width", `${vbWidth}px`);
  } else {
    svgEl.setAttribute("width", "100%");
  }
  svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svgEl.setAttribute("shape-rendering", "geometricPrecision");
  svgEl.setAttribute("text-rendering", "geometricPrecision");
  const style = svgEl.getAttribute("style");
  if (style) {
    // 移除 mermaid 注入的 max-width 和任何 background-color,
    // 让 SVG 背景透明,继承容器(代码块)的主题色
    const cleaned = style
      .replace(/max-width\s*:[^;]+;?/gi, "")
      .replace(/background(-color)?\s*:[^;]+;?/gi, "")
      .trim();
    if (cleaned) svgEl.setAttribute("style", cleaned);
    else svgEl.removeAttribute("style");
  }
  return new XMLSerializer().serializeToString(svgEl);
}

function getSvgVectorSize(svgEl: SVGSVGElement): { width: number; height: number } {
  const viewBox = svgEl.getAttribute("viewBox");
  if (viewBox) {
    const parts = viewBox.split(/[\s,]+/).map(Number).filter(Number.isFinite);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }
  const w = parseFloat(svgEl.getAttribute("width") ?? "");
  const h = parseFloat(svgEl.getAttribute("height") ?? "");
  if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) {
    return { width: w, height: h };
  }
  return { width: 800, height: 600 };
}

function downloadSvgAsPng(originalSvg: string, background: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(originalSvg, "image/svg+xml");
    const svgEl = doc.documentElement as unknown as SVGSVGElement;
    const isParseError =
      doc.getElementsByTagName("parsererror").length > 0 ||
      svgEl.tagName.toLowerCase() !== "svg";
    if (isParseError) {
      reject(new Error("svg parse failed"));
      return;
    }
    const { width: vbW, height: vbH } = getSvgVectorSize(svgEl);
    const targetWidth = Math.max(2000, Math.ceil(vbW * 4));
    const targetHeight = Math.round((targetWidth * vbH) / vbW);
    svgEl.setAttribute("width", String(targetWidth));
    svgEl.setAttribute("height", String(targetHeight));
    if (!svgEl.getAttribute("viewBox")) {
      svgEl.setAttribute("viewBox", `0 0 ${vbW} ${vbH}`);
    }
    svgEl.removeAttribute("style");
    const serializer = new XMLSerializer();
    const svgStr = serializer.serializeToString(svgEl);
    const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svgStr}`], {
      type: "image/svg+xml;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas 2d context unavailable");
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, targetWidth, targetHeight);
        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
        URL.revokeObjectURL(url);
        canvas.toBlob((out) => {
          if (!out) {
            reject(new Error("canvas toBlob returned null"));
            return;
          }
          const a = document.createElement("a");
          a.href = URL.createObjectURL(out);
          a.download = `mermaid-${Date.now()}.png`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(a.href);
          resolve();
        }, "image/png");
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("svg image decode failed"));
    };
    img.src = url;
  });
}

const LIGHTBOX_MIN_SCALE = 0.2;
const LIGHTBOX_MAX_SCALE = 8;
const LIGHTBOX_SCALE_STEP = 0.1;

function MermaidLightbox({ svg, onClose }: { svg: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragStateRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  }>({ active: false, startX: 0, startY: 0, originX: 0, originY: 0 });
  const [dragging, setDragging] = useState(false);

  const resetView = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "+" || event.key === "=") {
        setScale((s) => Math.min(LIGHTBOX_MAX_SCALE, +(s + LIGHTBOX_SCALE_STEP).toFixed(2)));
      }
      if (event.key === "-" || event.key === "_") {
        setScale((s) => Math.max(LIGHTBOX_MIN_SCALE, +(s - LIGHTBOX_SCALE_STEP).toFixed(2)));
      }
      if (event.key === "0") resetView();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const state = dragStateRef.current;
      if (!state.active) return;
      event.preventDefault();
      setOffset({
        x: state.originX + (event.clientX - state.startX),
        y: state.originY + (event.clientY - state.startY)
      });
    };
    const onUp = () => {
      if (dragStateRef.current.active) {
        dragStateRef.current.active = false;
        setDragging(false);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  // 缩放变化时,若回到 1 自动归位(避免 scale=1 但 offset 还飘着)
  useEffect(() => {
    if (scale === 1) setOffset({ x: 0, y: 0 });
  }, [scale]);

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const delta = event.deltaY < 0 ? LIGHTBOX_SCALE_STEP : -LIGHTBOX_SCALE_STEP;
    setScale((s) => {
      const next = +(s + delta).toFixed(2);
      return Math.min(LIGHTBOX_MAX_SCALE, Math.max(LIGHTBOX_MIN_SCALE, next));
    });
  };

  const zoomBy = (delta: number) =>
    setScale((s) =>
      Math.min(LIGHTBOX_MAX_SCALE, Math.max(LIGHTBOX_MIN_SCALE, +(s + delta).toFixed(2)))
    );

  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragStateRef.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y
    };
    setDragging(true);
  };

  const canDrag = true;

  return createPortal(
    <div
      className="mermaid-lightbox"
      onClick={onClose}
      onWheel={onWheel}
      role="dialog"
      aria-modal="true"
      aria-label="Mermaid 图预览"
    >
      <div className="mermaid-lightbox-toolbar" onClick={(event) => event.stopPropagation()}>
        <button
          aria-label="缩小"
          disabled={scale <= LIGHTBOX_MIN_SCALE}
          onClick={() => zoomBy(-LIGHTBOX_SCALE_STEP)}
          title="缩小 (Alt+滚轮下 或 -)"
          type="button"
        >
          <Minus size={15} />
        </button>
        <span className="mermaid-lightbox-scale">{Math.round(scale * 100)}%</span>
        <button
          aria-label="放大"
          disabled={scale >= LIGHTBOX_MAX_SCALE}
          onClick={() => zoomBy(LIGHTBOX_SCALE_STEP)}
          title="放大 (Alt+滚轮上 或 +)"
          type="button"
        >
          <Plus size={15} />
        </button>
        <button
          aria-label="重置视图"
          disabled={scale === 1 && offset.x === 0 && offset.y === 0}
          onClick={resetView}
          title="重置视图 (0)"
          type="button"
        >
          <RotateCcw size={14} />
        </button>
        <button aria-label="关闭" onClick={onClose} title="关闭 (Esc)" type="button">
          <X size={15} />
        </button>
      </div>
      <div
        className={`mermaid-lightbox-inner${dragging ? " is-dragging" : ""}${canDrag ? " is-pannable" : ""}`}
        dangerouslySetInnerHTML={{ __html: svg }}
        onClick={(event) => event.stopPropagation()}
        onMouseDown={onMouseDown}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          transformOrigin: "center center"
        }}
      />
      {canDrag ? (
        <div className="mermaid-lightbox-hint">按住拖动平移 · 滚轮缩放 · 0 重置</div>
      ) : null}
    </div>,
    document.body
  );
}

export function MermaidBlock({ code }: { code: string; followOutput: boolean }) {
  const { activeVariant, prismTheme, resolvedScheme } = useTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [view, setView] = useState<View>("render");
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [showLightbox, setShowLightbox] = useState(false);
  const renderIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const myId = ++renderIdRef.current;
    const timer = setTimeout(async () => {
      try {
        const domId = `mermaid-${myId.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const result = await renderMermaid(code, domId, activeVariant);
        if (cancelled || myId !== renderIdRef.current) return;
        setSvg(normalizeSvgForDisplay(result));
        setLoading(false);
        setView("render");
      } catch {
        if (cancelled || myId !== renderIdRef.current) return;
        setSvg(null);
        setLoading(false);
        setView("code");
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeVariant, code, resolvedScheme]);

  const headerActions = (
    <span className="markdown-code-actions">
      <button
          aria-label={view === "render" ? "查看源码" : "查看渲染图"}
          className={view === "code" ? "is-active" : ""}
          onClick={() => setView(view === "render" ? "code" : "render")}
          title={view === "render" ? "查看源码" : "查看渲染图"}
          type="button"
        >
          {view === "render" ? <Code2 size={13} /> : <Eye size={13} />}
      </button>
      <button
          aria-label="放大查看"
          disabled={!svg || view !== "render"}
          onClick={() => setShowLightbox(true)}
          title="放大查看"
          type="button"
        >
          <Maximize2 size={13} />
      </button>
      <button
          aria-label="下载 PNG"
          disabled={!svg || downloading}
          onClick={async () => {
            if (!svg || downloading) return;
            setDownloading(true);
            try {
              await downloadSvgAsPng(svg, activeVariant.colors.background);
            } finally {
              setDownloading(false);
            }
          }}
          title="下载 PNG"
          type="button"
        >
          {downloading ? <LoaderCircle size={13} className="spin" /> : <Download size={13} />}
      </button>
      <button
          aria-label="复制源码"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1_500);
            }).catch(() => undefined);
          }}
          title={copied ? "已复制" : "复制源码"}
          type="button"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </span>
  );

  return (
    <section className="markdown-code-block markdown-code-block-mermaid">
      <header>
        <span className="markdown-code-language"><Code2 size={12} />Mermaid</span>
        {headerActions}
      </header>
      {view === "render" && (svg || loading) ? (
        <div
          className="markdown-mermaid-render"
          onClick={() => svg && setShowLightbox(true)}
          role="img"
          tabIndex={0}
        >
          {loading && !svg ? (
            <div className="markdown-mermaid-loading">
              <LoaderCircle size={16} className="spin" />
              <span>正在渲染图…</span>
            </div>
          ) : svg ? (
            <div dangerouslySetInnerHTML={{ __html: svg }} />
          ) : null}
        </div>
      ) : (
        <Highlight code={code} language="text" theme={prismTheme}>
          {({ className, getLineProps, getTokenProps, style, tokens }) => (
            <pre className={className} style={{ ...style, background: "transparent" }}>
              <code>
                {tokens.map((line, lineIndex) => {
                  const lineProps = getLineProps({ line });
                  return (
                    <span
                      {...lineProps}
                      className={`markdown-code-line ${lineProps.className ?? ""}`.trim()}
                      key={lineIndex}
                    >
                      {line.map((token, tokenIndex) => (
                        <span key={tokenIndex} {...getTokenProps({ token })} />
                      ))}
                      {lineIndex < tokens.length - 1 ? "\n" : null}
                    </span>
                  );
                })}
              </code>
            </pre>
          )}
        </Highlight>
      )}
      {showLightbox && svg ? <MermaidLightbox svg={svg} onClose={() => setShowLightbox(false)} /> : null}
    </section>
  );
}
