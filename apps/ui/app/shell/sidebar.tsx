"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { GlyphSlot, ROW_LANE, SECTION_LABEL, SECTION_LANE } from "./lanes";

/**
 * One row in the sidebar.
 *
 * Deliberately not `SidebarMenuButton` from the copied shadcn set: that one
 * reads `useSidebar()`, which means a `SidebarProvider` with its own width and
 * collapse state — a second opinion about the same two facts our layout store
 * already owns. The metrics here are the ones it uses, so rows line up either
 * way.
 */
export const ROW_CLASS = cn(
  "group/row hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground relative flex h-8 w-full items-center gap-2 overflow-hidden rounded-md pe-2 text-start text-[13px] transition-colors outline-hidden focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 data-active:font-medium",
  ROW_LANE,
);

export function SidebarRow({
  glyph,
  active,
  trailing,
  className,
  children,
  ...props
}: React.ComponentProps<"button"> & {
  glyph?: ReactNode;
  active?: boolean;
  /** Shown at the row's right edge — a count, a chevron, a menu. */
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      data-active={active || undefined}
      className={cn(ROW_CLASS, className)}
      {...props}
    >
      <RowInside glyph={glyph} trailing={trailing}>
        {children}
      </RowInside>
    </button>
  );
}

/**
 * A row that navigates. An anchor, not a button with an `onClick` — a route
 * change has to survive a middle click and show its target in the status bar,
 * and a button does neither.
 */
export function SidebarRowLink({
  glyph,
  trailing,
  className,
  children,
  ...props
}: React.ComponentProps<typeof Link> & {
  glyph?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <Link className={cn(ROW_CLASS, className)} {...props}>
      <RowInside glyph={glyph} trailing={trailing}>
        {children}
      </RowInside>
    </Link>
  );
}

function RowInside({
  glyph,
  trailing,
  children,
}: {
  glyph?: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <GlyphSlot>{glyph}</GlyphSlot>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </>
  );
}

/** A section heading. It sits on the glyph lane, one step left of the titles. */
export function SidebarSection({
  action,
  children,
}: {
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex h-7 items-center justify-between gap-2",
        SECTION_LANE,
      )}
    >
      <span className={SECTION_LABEL}>{children}</span>
      {action}
    </div>
  );
}

/** The scrolling column the rows live in. */
export function SidebarBody({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 py-2">
      {children}
    </div>
  );
}

export function SidebarFooterArea({ children }: { children: ReactNode }) {
  return (
    <div className="border-border/60 shrink-0 border-t px-2 py-2">{children}</div>
  );
}
