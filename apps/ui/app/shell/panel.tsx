"use client";

import { FileTextIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { layout, type PanelTab } from "./layout";

const TITLES: Record<PanelTab, string> = {
  library: "Library",
  notifications: "Notifications",
  session: "Session",
};

const EMPTY: Record<PanelTab, string> = {
  library: "Files a task produces will collect here.",
  notifications: "Nothing needs your attention.",
  session: "Details about the open session will appear here.",
};

/**
 * The right pane.
 *
 * Its three tabs are all empty for now, and they say so plainly rather than
 * being left out. The pane is part of the shape — the header toggle and the rail
 * both point at it — and a toggle that opens nothing is worse than a pane that
 * admits it is waiting on the backend.
 */
export function SidePanel({ tab }: { tab: PanelTab }) {
  return (
    <>
      <div className="border-border flex h-9 shrink-0 items-center justify-between border-b px-3">
        <span className="text-[13px] font-medium">{TITLES[tab]}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:bg-muted hover:text-foreground -me-1.5 rounded-xl"
          aria-label="Close side panel"
          onClick={layout.closeRight}
        >
          <XIcon size={16} />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <FileTextIcon size={20} className="text-muted-foreground" />
        <p className="text-muted-foreground text-[13px]">{EMPTY[tab]}</p>
      </div>
    </>
  );
}
