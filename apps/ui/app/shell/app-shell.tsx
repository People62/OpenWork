"use client";

import type { ReactNode } from "react";
import { PanelLeftIcon, PanelRightIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LEFT_MIN, layout, useLayout } from "./layout";
import { useDragWidth } from "./resize";

/**
 * The frame every screen sits in.
 *
 * The shape is OpenWork's, and the shape is the point: the window background is the
 * sidebar's own colour, and the content floats on top of it as a rounded card
 * with a border and a soft shadow, inset 8px from the top and left. Panes
 * divided by plain 1px rules — which is what we had — read as a settings dialog,
 * not as an application.
 */
export type AppShellProps = {
  /** Contents of the left sidebar. It supplies its own scrolling. */
  sidebar: ReactNode;
  /** The 13px line at the top left of the card. */
  title: ReactNode;
  /** Buttons at the top right of the card, left of the panel toggle. */
  headerActions?: ReactNode;
  /** Icon buttons on the far-right rail, top to bottom. */
  rail?: ReactNode;
  /** Shown in the right pane when one is open. */
  panel?: ReactNode;
  children: ReactNode;
};

export function AppShell(props: AppShellProps) {
  const state = useLayout();

  const startLeftDrag = useDragWidth({
    initial: () => layout.get().leftWidth,
    direction: 1,
    onChange: layout.setLeftWidth,
  });
  const startRightDrag = useDragWidth({
    initial: () => layout.get().rightWidth,
    direction: -1,
    onChange: layout.setRightWidth,
  });

  const panelOpen = state.rightTab !== null && props.panel !== undefined;

  return (
    <div className="bg-dls-sidebar text-dls-text flex h-screen min-h-0 overflow-hidden">
      <aside
        className={cn(
          "relative flex min-h-0 shrink-0 flex-col",
          // Only the width animates, and only when it is not being dragged —
          // a transition on a pointer-driven width lags a frame behind the
          // cursor, which reads as the pane being heavy.
          state.leftCollapsed && "w-0 overflow-hidden",
        )}
        style={state.leftCollapsed ? undefined : { width: state.leftWidth }}
        data-collapsed={state.leftCollapsed || undefined}
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {props.sidebar}
        </div>
        {/* A 4px grab strip that draws as a 1px rule. Anything thinner is a
            target you have to aim at. */}
        {state.leftCollapsed ? null : (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            onPointerDown={startLeftDrag}
            onDoubleClick={() => layout.setLeftWidth(LEFT_MIN)}
            className="hover:after:bg-primary/40 absolute inset-y-0 -right-0.5 z-20 w-1 cursor-col-resize after:absolute after:inset-y-0 after:left-0 after:w-px after:bg-transparent after:transition-colors"
          />
        )}
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 lg:py-2 lg:pl-2">
        <main className="bg-dls-surface border-border flex h-full min-w-0 flex-1 flex-col overflow-hidden shadow-[0_8px_24px_rgba(15,23,42,0.06)] max-lg:rounded-none max-lg:border-0 max-lg:shadow-none lg:rounded-[14px] lg:border dark:lg:shadow-[0_10px_30px_rgba(0,0,0,0.45)]">
          <header className="border-border z-10 flex h-9 shrink-0 items-center justify-between border-b px-3 max-lg:h-12 lg:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:bg-muted hover:text-foreground -ms-1.5 rounded-xl"
                aria-label={state.leftCollapsed ? "Show sidebar" : "Hide sidebar"}
                aria-pressed={!state.leftCollapsed}
                onClick={layout.toggleLeft}
              >
                <PanelLeftIcon size={16} />
              </Button>
              <h1 className="text-dls-text truncate text-[13px] font-medium">
                {props.title}
              </h1>
            </div>

            <div className="text-muted-foreground flex items-center gap-1.5">
              {props.headerActions}
              {props.panel === undefined ? null : (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn(
                    "hover:bg-muted hover:text-foreground hidden rounded-xl text-muted-foreground transition-colors lg:inline-flex",
                    panelOpen &&
                      "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
                  )}
                  aria-label={panelOpen ? "Close side panel" : "Open side panel"}
                  aria-pressed={panelOpen}
                  onClick={() => layout.toggleRight("session")}
                >
                  <PanelRightIcon size={16} />
                </Button>
              )}
            </div>
          </header>

          <div className="flex min-h-0 flex-1">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {props.children}
            </div>

            {panelOpen ? (
              <div
                className="relative hidden min-h-0 shrink-0 lg:flex"
                style={{ width: state.rightWidth }}
              >
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize side panel"
                  onPointerDown={startRightDrag}
                  className="hover:bg-primary/40 absolute inset-y-0 -left-0.5 z-20 w-1 cursor-col-resize bg-transparent transition-colors"
                />
                <div className="border-border flex min-h-0 flex-1 flex-col overflow-hidden border-s">
                  {props.panel}
                </div>
              </div>
            ) : null}
          </div>
        </main>

        {props.rail === undefined ? null : (
          <aside className="text-muted-foreground hidden w-9 shrink-0 flex-col items-center gap-1 px-0.5 py-2 lg:flex">
            {props.rail}
          </aside>
        )}
      </div>
    </div>
  );
}
