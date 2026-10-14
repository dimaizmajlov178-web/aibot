"use client";

import { onMessage, offMessage, postMessage } from "./channel";
import {
  computeDisplaySelector,
  computeSelector,
  computeXPath,
} from "./element-selector";

export interface InspectorAppearance {
  outlineColor: string;
  overlayColor: string;
  labelBackgroundColor: string;
  labelTextColor: string;
}

interface InspectorState {
  active: boolean;
  hoveredElement: Element | null;
  appearance: InspectorAppearance;
}

const DEFAULT_APPEARANCE: InspectorAppearance = {
  outlineColor: "#3b82f6",
  overlayColor: "rgba(59, 130, 246, 0.3)",
  labelBackgroundColor: "#000000",
  labelTextColor: "#ffffff",
};

let state: InspectorState = {
  active: false,
  hoveredElement: null,
  appearance: DEFAULT_APPEARANCE,
};

const listeners = new Set<(state: InspectorState) => void>();
let selectedElementHighlightCleanup: (() => void) | null = null;

export function getState(): InspectorState {
  return state;
}

export function subscribe(callback: (state: InspectorState) => void) {
  listeners.add(callback);
  callback(state);
  return () => listeners.delete(callback);
}

function setState(patch: Partial<InspectorState>) {
  state = { ...state, ...patch };
  listeners.forEach((cb) => cb(state));
}

function getInspectorColor(value: unknown, fallback: string): string {
  return typeof value === "string" && CSS.supports("color", value)
    ? value
    : fallback;
}

function clearSelectedElementHighlight() {
  const cleanup = selectedElementHighlightCleanup;
  selectedElementHighlightCleanup = null;
  cleanup?.();
}

function highlightSelectedElement(
  element: Element,
  appearance: InspectorAppearance
) {
  clearSelectedElementHighlight();

  if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) {
    return;
  }

  const previousStyles = {
    outline: element.style.outline,
    outlineOffset: element.style.outlineOffset,
    backgroundColor: element.style.backgroundColor,
  };

  element.style.outline = `1px solid ${appearance.outlineColor}`;
  element.style.outlineOffset = "-1px";
  element.style.backgroundColor = appearance.overlayColor;

  selectedElementHighlightCleanup = () => {
    element.style.outline = previousStyles.outline;
    element.style.outlineOffset = previousStyles.outlineOffset;
    element.style.backgroundColor = previousStyles.backgroundColor;
  };
}

export function init() {
  const handleMouseMove = (e: MouseEvent) => {
    if (!state.active) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== state.hoveredElement) {
      setState({ hoveredElement: el });
      const selector = computeSelector(el);
      postMessage({
        type: "inspector-hovered",
        payload: { selector, tagName: el.tagName.toLowerCase() },
      });
    }
  };

  const handleClick = (e: MouseEvent) => {
    if (!state.active) return;
    e.preventDefault();
    e.stopPropagation();

    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const selector = computeSelector(el);
    postMessage({
      type: "element-selected",
      payload: {
        selector,
        displaySelector: computeDisplaySelector(el, selector),
        xpath: computeXPath(el),
        tagName: el.tagName.toLowerCase(),
        text: el.textContent?.slice(0, 200) || undefined,
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
      },
    });

    highlightSelectedElement(el, state.appearance);
    setState({ active: false, hoveredElement: null });
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && state.active) {
      setState({ active: false, hoveredElement: null });
    }
  };

  const handleToggleInspector = (message: { payload?: unknown }) => {
    const payload = message.payload as
      | {
          enabled?: boolean;
          appearance?: {
            outlineColor?: unknown;
            overlayColor?: unknown;
            labelBackgroundColor?: unknown;
            labelTextColor?: unknown;
          };
        }
      | undefined;
    const enabled = payload?.enabled ?? true;
    const appearance = {
      outlineColor: getInspectorColor(
        payload?.appearance?.outlineColor,
        DEFAULT_APPEARANCE.outlineColor
      ),
      overlayColor: getInspectorColor(
        payload?.appearance?.overlayColor,
        DEFAULT_APPEARANCE.overlayColor
      ),
      labelBackgroundColor: getInspectorColor(
        payload?.appearance?.labelBackgroundColor,
        DEFAULT_APPEARANCE.labelBackgroundColor
      ),
      labelTextColor: getInspectorColor(
        payload?.appearance?.labelTextColor,
        DEFAULT_APPEARANCE.labelTextColor
      ),
    };
    clearSelectedElementHighlight();
    setState({
      active: enabled,
      hoveredElement: null,
      appearance,
    });
  };

  onMessage("toggle-inspector", handleToggleInspector);

  window.addEventListener("mousemove", handleMouseMove);
  window.addEventListener("click", handleClick, true);
  window.addEventListener("keydown", handleKeyDown);

  return () => {
    clearSelectedElementHighlight();
    window.removeEventListener("mousemove", handleMouseMove);
    window.removeEventListener("click", handleClick, true);
    window.removeEventListener("keydown", handleKeyDown);
    offMessage("toggle-inspector");
  };
}
