"use client";

import { useEffect, useState } from "react";
import { subscribe, getState } from "@/lib/bridge/inspector";

export function InspectorOverlay() {
  const [inspectorState, setInspectorState] = useState(getState);

  useEffect(() => {
    const unsubscribe = subscribe(setInspectorState);
    return () => {
      unsubscribe();
    };
  }, []);

  if (
    !inspectorState.active ||
    !inspectorState.hoveredElement?.isConnected
  ) {
    return null;
  }

  const targetElement = inspectorState.hoveredElement;
  const rect = targetElement.getBoundingClientRect();
  const { appearance } = inspectorState;

  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        pointerEvents: "none",
        zIndex: 999999,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          bottom: "calc(100% + 2px)",
          padding: "2px 8px",
          borderRadius: 5,
          backgroundColor: appearance.labelBackgroundColor,
          color: appearance.labelTextColor,
          fontFamily: "Arial, sans-serif",
          fontSize: 13,
          fontWeight: 400,
          lineHeight: "18px",
          whiteSpace: "nowrap",
        }}
      >
        {targetElement.tagName.toLowerCase()}
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          boxSizing: "border-box",
          border: `2px solid ${appearance.outlineColor}`,
        }}
      />
    </div>
  );
}
