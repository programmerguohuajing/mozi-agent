/**
 * AnnotationOverlay — Mozi Studio 生产级 UI。
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
  screenshotBase64: string;
  width: number;
  height: number;
  onConfirm: (annotatedBase64: string) => void;
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
  const [textInput, setTextInput] = React.useState<{ x: number; y: number; value: string } | null>(
    null,
  );

  const dataUrl = props.screenshotBase64.startsWith('data:')
    ? props.screenshotBase64
    : `data:image/png;base64,${props.screenshotBase64}`;

  const render = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const img = bgRef.current;
    if (img?.complete) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const a of annotations) drawAnnotation(ctx, a);
  }, [annotations]);

  React.useEffect(() => {
    const img = new Image();
    img.onload = () => render();
    img.src = dataUrl;
    bgRef.current = img;
  }, [dataUrl, render]);

  const getPos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const pos = getPos(e);
    if (tool === 'text') {
      setTextInput({ x: pos.x, y: pos.y, value: '' });
      return;
    }
    setDrawing(true);
    setStart(pos);
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    if (!drawing) return;
    const pos = getPos(e);
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvasRef.current?.width, canvasRef.current?.height);
    const img = bgRef.current;
    if (img?.complete)
      ctx.drawImage(img, 0, 0, canvasRef.current?.width, canvasRef.current?.height);
    for (const a of annotations) drawAnnotation(ctx, a);
    drawAnnotation(ctx, {
      tool,
      x: start.x,
      y: start.y,
      width: pos.x - start.x,
      height: pos.y - start.y,
      color,
    });
  };

  const onMouseUp = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    if (!drawing) return;
    setDrawing(false);
    const pos = getPos(e);
    const annotation: Annotation = {
      tool,
      x: start.x,
      y: start.y,
      width: pos.x - start.x,
      height: pos.y - start.y,
      color,
    };
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
      {
        tool: 'text',
        x: textInput.x,
        y: textInput.y,
        width: 0,
        height: 0,
        color,
        text: textInput.value,
      },
    ]);
    setTextInput(null);
  };

  const handleConfirm = (): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL('image/png');
    props.onConfirm(dataUrl.replace(/^data:image\/png;base64,/, ''));
  };

  return (
    <div className="annotation-overlay">
      <div className="annotation-toolbar">
        <span style={{ color: 'var(--text-2)' }}>标注工具：</span>
        {(['rect', 'arrow', 'text', 'highlight'] as AnnotationTool[]).map((t) => (
          <button
            key={t}
            className={`btn-sm ${tool === t ? 'primary' : ''}`}
            onClick={() => setTool(t)}
          >
            {{ rect: '矩形', arrow: '箭头', text: '文字', highlight: '高亮' }[t]}
          </button>
        ))}
        <span style={{ margin: '0 8px', color: 'var(--text-3)' }}>|</span>
        <span style={{ color: 'var(--text-2)' }}>颜色：</span>
        {COLORS.map((c) => (
          <button
            key={c}
            style={{
              height: 24,
              width: 24,
              borderRadius: 'var(--radius-xs)',
              border: `2px solid ${color === c ? 'white' : 'transparent'}`,
              background: c,
              cursor: 'pointer',
            }}
            onClick={() => setColor(c)}
          />
        ))}
        <span style={{ margin: '0 8px', color: 'var(--text-3)' }}>|</span>
        <button className="btn-sm" onClick={() => setAnnotations((prev) => prev.slice(0, -1))}>
          撤销
        </button>
        <button className="btn-sm" onClick={() => setAnnotations([])}>
          清空
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn-sm" onClick={props.onCancel}>
            取消
          </button>
          <button className="btn-sm primary" onClick={handleConfirm}>
            确认并保存到输入框
          </button>
        </div>
      </div>
      <div className="annotation-canvas-area">
        <canvas
          ref={canvasRef}
          width={props.width || 1200}
          height={props.height || 800}
          style={{
            maxHeight: '100%',
            maxWidth: '100%',
            cursor: 'crosshair',
            borderRadius: 'var(--radius)',
            boxShadow: 'var(--shadow-lg)',
          }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
        />
        {textInput ? (
          <div
            style={{
              position: 'absolute',
              left: `${(textInput.x / (props.width || 1200)) * 100}%`,
              top: `${(textInput.y / (props.height || 800)) * 100}%`,
            }}
          >
            <input
              className="input-field"
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

function drawAnnotation(ctx: CanvasRenderingContext2D, a: Annotation): void {
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = 3;
  ctx.font = '16px sans-serif';
  switch (a.tool) {
    case 'rect':
      ctx.strokeRect(a.x, a.y, a.width, a.height);
      break;
    case 'arrow':
      drawArrow(ctx, a.x, a.y, a.x + a.width, a.y + a.height);
      break;
    case 'highlight':
      ctx.globalAlpha = 0.3;
      ctx.fillRect(a.x, a.y, a.width, a.height);
      ctx.globalAlpha = 1;
      break;
    case 'text':
      ctx.fillText(a.text ?? '', a.x, a.y);
      break;
  }
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  const headLen = 12;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.lineTo(
    x2 - headLen * Math.cos(angle - Math.PI / 6),
    y2 - headLen * Math.sin(angle - Math.PI / 6),
  );
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - headLen * Math.cos(angle + Math.PI / 6),
    y2 - headLen * Math.sin(angle + Math.PI / 6),
  );
  ctx.stroke();
}
