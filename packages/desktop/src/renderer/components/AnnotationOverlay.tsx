/**
 * AnnotationOverlay：截图标注覆盖层组件。
 *
 * 功能：在截图上绘制矩形框、箭头、文字标注，支持颜色选择与撤销。
 * 确认后将标注后的画布导出为 base64 PNG，传回父组件保存到输入框。
 *
 * 零外部依赖（纯 React + Canvas API）；Tailwind 样式与现有组件一致。
 */
import * as React from 'react';

export type AnnotationTool = 'rect' | 'arrow' | 'text' | 'highlight';

export interface Annotation {
  tool: AnnotationTool;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  text?: string;
}

export interface AnnotationOverlayProps {
  /** 截图 base64（PNG data URL 或 raw base64）。 */
  screenshotBase64: string;
  /** 截图原始宽度。 */
  width: number;
  /** 截图原始高度。 */
  height: number;
  /** 确认回调：返回标注后的 base64 PNG。 */
  onConfirm: (annotatedBase64: string) => void;
  /** 取消回调。 */
  onCancel: () => void;
}

const COLORS = ['#ef4444', '#f59e0b', '#3b82f6', '#22c55e', '#a855f7', '#ffffff'];

export function AnnotationOverlay(props: AnnotationOverlayProps): React.ReactElement {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const bgRef = React.useRef<HTMLImageElement>(null);
  const [tool, setTool] = React.useState<AnnotationTool>('rect');
  const [color, setColor] = React.useState(COLORS[0]!);
  const [drawing, setDrawing] = React.useState(false);
  const [start, setStart] = React.useState({ x: 0, y: 0 });
  const [annotations, setAnnotations] = React.useState<Annotation[]>([]);
  const [textInput, setTextInput] = React.useState<{ x: number; y: number; value: string } | null>(null);

  const dataUrl = props.screenshotBase64.startsWith('data:')
    ? props.screenshotBase64
    : `data:image/png;base64,${props.screenshotBase64}`;

  // 绘制所有标注到画布
  const render = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // 清空 + 重绘背景
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const img = bgRef.current;
    if (img && img.complete) {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    }
    // 绘制标注
    for (const a of annotations) {
      drawAnnotation(ctx, a);
    }
  }, [annotations]);

  React.useEffect(() => {
    const img = new Image();
    img.onload = () => render();
    img.src = dataUrl;
    bgRef.current = img;
  }, [dataUrl, render]);

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;

    if (tool === 'text') {
      setTextInput({ x, y, value: '' });
      return;
    }

    setDrawing(true);
    setStart({ x, y });
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    if (!drawing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;

    // 重绘 + 当前临时标注
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const img = bgRef.current;
    if (img && img.complete) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const a of annotations) drawAnnotation(ctx, a);
    // 临时绘制当前
    drawAnnotation(ctx, {
      tool,
      x: start.x,
      y: start.y,
      width: x - start.x,
      height: y - start.y,
      color,
    });
  };

  const onMouseUp = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    if (!drawing) return;
    setDrawing(false);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;

    const annotation: Annotation = {
      tool,
      x: start.x,
      y: start.y,
      width: x - start.x,
      height: y - start.y,
      color,
    };
    // 最小尺寸过滤
    if (Math.abs(annotation.width) > 3 || Math.abs(annotation.height) > 3) {
      setAnnotations((prev) => [...prev, annotation]);
    }
  };

  const confirmText = (): void => {
    if (!textInput || !textInput.value.trim()) {
      setTextInput(null);
      return;
    }
    setAnnotations((prev) => [
      ...prev,
      { tool: 'text', x: textInput.x, y: textInput.y, width: 0, height: 0, color, text: textInput.value },
    ]);
    setTextInput(null);
  };

  const undo = (): void => {
    setAnnotations((prev) => prev.slice(0, -1));
  };

  const clearAll = (): void => {
    setAnnotations([]);
  };

  const handleConfirm = (): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // 导出为 base64 PNG（去掉 data: 前缀）
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    props.onConfirm(base64);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/80">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 border-b border-neutral-700 bg-neutral-900 px-4 py-2 text-sm">
        <span className="text-neutral-400">标注工具：</span>
        {(['rect', 'arrow', 'text', 'highlight'] as AnnotationTool[]).map((t) => (
          <button
            key={t}
            className={`rounded px-2 py-1 ${tool === t ? 'bg-emerald-600 text-white' : 'bg-neutral-800 hover:bg-neutral-700'}`}
            onClick={() => setTool(t)}
          >
            {{ rect: '矩形', arrow: '箭头', text: '文字', highlight: '高亮' }[t]}
          </button>
        ))}
        <span className="mx-2 text-neutral-600">|</span>
        <span className="text-neutral-400">颜色：</span>
        {COLORS.map((c) => (
          <button
            key={c}
            className={`h-6 w-6 rounded border-2 ${color === c ? 'border-white' : 'border-transparent'}`}
            style={{ backgroundColor: c }}
            onClick={() => setColor(c)}
          />
        ))}
        <span className="mx-2 text-neutral-600">|</span>
        <button className="rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700" onClick={undo}>
          撤销
        </button>
        <button className="rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700" onClick={clearAll}>
          清空
        </button>
        <div className="ml-auto flex gap-2">
          <button className="rounded bg-neutral-700 px-4 py-1 hover:bg-neutral-600" onClick={props.onCancel}>
            取消
          </button>
          <button
            className="rounded bg-emerald-600 px-4 py-1 text-white hover:bg-emerald-500"
            onClick={handleConfirm}
          >
            确认并保存到输入框
          </button>
        </div>
      </div>

      {/* 画布区域 */}
      <div className="relative flex flex-1 items-center justify-center overflow-auto p-4">
        <canvas
          ref={canvasRef}
          width={props.width || 1200}
          height={props.height || 800}
          className="max-h-full max-w-full cursor-crosshair rounded shadow-2xl"
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
        />
        {textInput ? (
          <div
            className="absolute"
            style={{
              left: `${(textInput.x / (props.width || 1200)) * 100}%`,
              top: `${(textInput.y / (props.height || 800)) * 100}%`,
            }}
          >
            <input
              autoFocus
              className="rounded bg-neutral-800 px-2 py-1 text-sm text-white"
              placeholder="输入标注文字…"
              value={textInput.value}
              onChange={(e) => setTextInput({ ...textInput, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmText();
                if (e.key === 'Escape') setTextInput(null);
              }}
              onBlur={confirmText}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 在 Canvas 上绘制单个标注。 */
function drawAnnotation(ctx: CanvasRenderingContext2D, a: Annotation): void {
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = 3;
  ctx.font = '16px sans-serif';

  switch (a.tool) {
    case 'rect': {
      ctx.strokeRect(a.x, a.y, a.width, a.height);
      break;
    }
    case 'arrow': {
      drawArrow(ctx, a.x, a.y, a.x + a.width, a.y + a.height);
      break;
    }
    case 'highlight': {
      ctx.globalAlpha = 0.3;
      ctx.fillRect(a.x, a.y, a.width, a.height);
      ctx.globalAlpha = 1;
      break;
    }
    case 'text': {
      ctx.fillText(a.text ?? '', a.x, a.y);
      break;
    }
  }
}

/** 绘制箭头线。 */
function drawArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  const headLen = 12;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
  ctx.stroke();
}