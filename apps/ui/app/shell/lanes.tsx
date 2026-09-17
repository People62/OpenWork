import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Sidebar lane system — two vertical rails shared by every row in the sidebar.
 *
 *   8px   row pill edge (SidebarGroup `mx-2`)
 *   20px  glyph lane  — activity dots, chevrons, row icons, section labels
 *   44px  label lane  — every row title (glyph lane + 16px glyph + 8px `gap-2`)
 *
 * Rules:
 * 1. A row's first child is a `GlyphSlot`, rendered even when it has no glyph,
 *    so the title never shifts when an indicator appears.
 * 2. Section labels sit on the glyph lane, one step left of the titles below.
 * 3. Nesting steps right by 12px per depth level.
 *
 * Taken from the reference verbatim. These are measurements, not opinions —
 * rewriting them would only move rows off the rails they share.
 */

/** Row padding that puts the glyph slot on the glyph lane. */
export const ROW_LANE = "ps-3";

/** One nesting step right of `ROW_LANE`. */
export const ROW_LANE_NESTED = "ps-6";

/** Matches the nav row icon column: `mx-2` gutter plus `ps-2.5`. */
export const SECTION_LANE = "mx-2 ps-2.5 pe-2";

// Regular weight, not semibold: at 11px a heavier weight thickens the letter
// shapes instead of building hierarchy.
export const SECTION_LABEL = "text-[11px] text-muted-foreground";

const GLYPH_SLOT = "flex size-4 shrink-0 items-center justify-center";

/** The 16px glyph lane of a sidebar row. Always render it, empty or not. */
export function GlyphSlot({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      aria-hidden={children ? undefined : "true"}
      className={cn(GLYPH_SLOT, className)}
    >
      {children}
    </span>
  );
}
