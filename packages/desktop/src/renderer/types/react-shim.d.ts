/**
 * 最小 React 类型声明（无重依赖策略）。
 *
 * 仓库未安装 react / @types/react（保持 `pnpm i` 干净）。渲染进程源码仍以标准
 * React API 编写；此处提供**仅供类型检查**的最小环境声明，运行时由真实 React 提供。
 * 安装真依赖后（`pnpm add react react-dom @types/react`）可从 tsconfig 移除本目录。
 */
declare namespace React {
  type ReactNode = unknown;
  type Key = string | number;
  interface ReactElement {
    type: unknown;
    props: unknown;
    key: Key | null;
  }

  interface RefObject<T> {
    current: T | null;
  }

  interface CSSProperties {
    [key: string]: string | number | undefined;
  }

  /** DOM 事件（最小）。 */
  interface SyntheticEvent<T = Element> {
    target: T;
    currentTarget: T;
    preventDefault(): void;
    stopPropagation(): void;
  }
  interface ChangeEvent<T = Element> extends SyntheticEvent<T> {
    target: T & { value: string; checked: boolean };
  }
  interface KeyboardEvent<T = Element> extends SyntheticEvent<T> {
    key: string;
    shiftKey: boolean;
  }
  interface MouseEvent<T = Element> extends SyntheticEvent<T> {}

  interface HTMLAttributes<T = Element> {
    key?: Key;
    className?: string;
    style?: CSSProperties;
    title?: string;
    children?: ReactNode;
    onClick?: (e: MouseEvent<T>) => void;
    onChange?: (e: ChangeEvent<T>) => void;
    onKeyDown?: (e: KeyboardEvent<T>) => void;
    [key: string]: unknown;
  }

  interface InputHTMLAttributes<T = Element> extends HTMLAttributes<T> {
    type?: string;
    value?: string | number | readonly string[];
    checked?: boolean;
    readOnly?: boolean;
    placeholder?: string;
    disabled?: boolean;
    min?: number;
  }

  interface TextareaHTMLAttributes<T = Element> extends HTMLAttributes<T> {
    value?: string;
    placeholder?: string;
  }

  interface SelectHTMLAttributes<T = Element> extends HTMLAttributes<T> {
    value?: string | number;
  }
}

declare module 'react' {
  export type ReactNode = React.ReactNode;
  export type ReactElement = React.ReactElement;
  export type Key = React.Key;
  export type CSSProperties = React.CSSProperties;
  export type ChangeEvent<T> = React.ChangeEvent<T>;
  export type KeyboardEvent<T> = React.KeyboardEvent<T>;
  export type MouseEvent<T> = React.MouseEvent<T>;

  export function useState<T>(initial: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void];
  export function useEffect(effect: () => undefined | (() => void), deps?: unknown[]): void;
  export function useMemo<T>(factory: () => T, deps: unknown[]): T;
  export function useRef<T>(initial: T | null): React.RefObject<T>;
  export function createElement(
    type: unknown,
    props?: unknown,
    ...children: unknown[]
  ): ReactElement;

  export interface FC<P = Record<string, unknown>> {
    (props: P): ReactElement | null;
    displayName?: string;
  }
  export type PropsWithChildren<P = Record<string, unknown>> = P & { children?: ReactNode };
  export const Fragment: unknown;
}

declare module 'react/jsx-runtime' {
  export const jsx: (type: unknown, props: unknown, key?: unknown) => React.ReactElement;
  export const jsxs: (type: unknown, props: unknown, key?: unknown) => React.ReactElement;
  export const Fragment: unknown;
}

declare module 'react-dom/client' {
  import type { ReactElement } from 'react';
  export function createRoot(container: Element): {
    render(el: ReactElement): void;
    unmount(): void;
  };
}

declare namespace JSX {
  type Element = React.ReactElement;
  interface ElementChildrenAttribute {
    children: unknown;
  }
  interface IntrinsicElements {
    div: React.HTMLAttributes<HTMLDivElement>;
    span: React.HTMLAttributes<HTMLSpanElement>;
    p: React.HTMLAttributes<HTMLParagraphElement>;
    ul: React.HTMLAttributes<HTMLUListElement>;
    ol: React.HTMLAttributes<HTMLOListElement>;
    li: React.HTMLAttributes<HTMLLIElement>;
    section: React.HTMLAttributes<HTMLElement>;
    aside: React.HTMLAttributes<HTMLElement>;
    header: React.HTMLAttributes<HTMLElement>;
    main: React.HTMLAttributes<HTMLElement>;
    footer: React.HTMLAttributes<HTMLElement>;
    h1: React.HTMLAttributes<HTMLHeadingElement>;
    h2: React.HTMLAttributes<HTMLHeadingElement>;
    h3: React.HTMLAttributes<HTMLHeadingElement>;
    pre: React.HTMLAttributes<HTMLPreElement>;
    code: React.HTMLAttributes<HTMLElement>;
    em: React.HTMLAttributes<HTMLElement>;
    strong: React.HTMLAttributes<HTMLElement>;
    br: React.HTMLAttributes<HTMLElement>;
    hr: React.HTMLAttributes<HTMLElement>;
    table: React.HTMLAttributes<HTMLTableElement>;
    thead: React.HTMLAttributes<HTMLTableSectionElement>;
    tbody: React.HTMLAttributes<HTMLTableSectionElement>;
    tr: React.HTMLAttributes<HTMLTableRowElement>;
    th: React.HTMLAttributes<HTMLTableCellElement>;
    td: React.HTMLAttributes<HTMLTableCellElement>;
    label: React.HTMLAttributes<HTMLLabelElement>;
    button: React.HTMLAttributes<HTMLButtonElement> & { disabled?: boolean };
    input: React.InputHTMLAttributes<HTMLInputElement>;
    textarea: React.TextareaHTMLAttributes<HTMLTextAreaElement>;
    select: React.SelectHTMLAttributes<HTMLSelectElement>;
    option: React.HTMLAttributes<HTMLOptionElement> & { value?: string | number };
    form: React.HTMLAttributes<HTMLFormElement>;
    svg: React.HTMLAttributes<SVGSVGElement> & {
      viewBox?: string;
      width?: number | string;
      height?: number | string;
    };
    g: React.HTMLAttributes<SVGGElement>;
    circle: React.HTMLAttributes<SVGCircleElement> & {
      cx?: number;
      cy?: number;
      r?: number;
      fill?: string;
      strokeWidth?: number;
      strokeDasharray?: string;
      transform?: string;
    };
    rect: React.HTMLAttributes<SVGRectElement> & {
      x?: number;
      y?: number;
      width?: number | string;
      height?: number | string;
      rx?: number;
    };
    text: React.HTMLAttributes<SVGTextElement> & {
      x?: number;
      y?: number;
      textAnchor?: string;
      className?: string;
    };
    details: React.HTMLAttributes<HTMLDetailsElement> & { open?: boolean };
    summary: React.HTMLAttributes<HTMLElement>;
    img: React.HTMLAttributes<HTMLImageElement> & { src?: string; alt?: string };
    a: React.HTMLAttributes<HTMLAnchorElement> & { href?: string };
  }
}
