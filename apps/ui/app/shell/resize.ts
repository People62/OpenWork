// Dragging a pane edge.
//
// Pointer events on `document`, not on the handle: once the pointer leaves the
// 4px handle mid-drag — which it does immediately — a handle-scoped listener
// stops hearing about it and the pane sticks. `pointercancel` matters too; a
// drag interrupted by the window losing focus otherwise leaves the body stuck
// with a resize cursor and no text selection.

"use client";

import { useCallback, useEffect, useRef } from "react";

export type ResizeOptions = {
  /** Width when the drag began. */
  initial: () => number;
  /** `+1` when dragging right widens the pane, `-1` when it narrows it. */
  direction: 1 | -1;
  onChange: (width: number) => void;
};

export function useDragWidth(options: ResizeOptions) {
  const cleanupRef = useRef<(() => void) | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const stop = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  return useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || typeof window === "undefined") return;
      event.preventDefault();
      stop();

      const startX = event.clientX;
      const startWidth = optionsRef.current.initial();
      const direction = optionsRef.current.direction;

      const move = (moveEvent: PointerEvent) => {
        optionsRef.current.onChange(
          startWidth + (moveEvent.clientX - startX) * direction,
        );
      };
      const end = () => stop();

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      cleanupRef.current = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        document.body.style.removeProperty("cursor");
        document.body.style.removeProperty("user-select");
      };
    },
    [stop],
  );
}
