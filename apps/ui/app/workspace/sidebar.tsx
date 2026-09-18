"use client";

import Link from "next/link";
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  BellIcon,
  ChevronRightIcon,
  CloudIcon,
  LayoutGridIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { GlyphSlot, ROW_LANE_NESTED } from "../shell/lanes";
import { layout, useLayout } from "../shell/layout";
import {
  SidebarBody,
  SidebarFooterArea,
  SidebarRow,
  SidebarSection,
} from "../shell/sidebar";
import { workspaceColor } from "../shell/avatar";
import { relativeAge, type AppState } from "./state";

/**
 * The left column.
 *
 * Its order is the reference's, and the order is the argument: the four things
 * you do to *start* work sit at the top, above any list, so they never move as
 * the lists below grow. Workspaces come next, each one a disclosure holding its
 * own sessions — sessions belong to a workspace, and the old two flat lists said
 * they were siblings.
 */
export type WorkspaceSidebarProps = {
  state: AppState;
  onNewTask: () => void;
};

export function WorkspaceSidebar({ state, onNewTask }: WorkspaceSidebarProps) {
  const panel = useLayout().rightTab;
  // Everything is open until it is closed: a workspace you just added showing
  // nothing would look like it failed to load.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  async function addWorkspace() {
    const path = await open({ directory: true, multiple: false });
    if (typeof path !== "string") return;
    // The last segment is nearly always the name that was wanted, and it can be
    // changed later.
    const name = path.split(/[/\\]/).filter(Boolean).pop() ?? path;
    await state.createWorkspace(name, path);
  }

  return (
    <>
      <SidebarBody>
        <div className="flex flex-col gap-0.5">
          <SidebarRow glyph={<SquarePenIcon />} onClick={onNewTask}>
            New task
          </SidebarRow>
          <SidebarRow glyph={<SearchIcon />}>Search sessions</SidebarRow>
          <SidebarRow
            glyph={<LayoutGridIcon />}
            active={panel === "library"}
            onClick={() => layout.toggleRight("library")}
          >
            Library
          </SidebarRow>
          <SidebarRow
            glyph={<BellIcon />}
            active={panel === "notifications"}
            onClick={() => layout.toggleRight("notifications")}
          >
            Notifications
          </SidebarRow>
        </div>

        <div className="mt-2 flex flex-col gap-0.5">
          <SidebarSection
            action={
              <button
                type="button"
                onClick={() => void addWorkspace()}
                disabled={state.busy}
                aria-label="Add workspace"
                title="Add workspace"
                className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground inline-flex size-5 items-center justify-center rounded transition-colors disabled:opacity-50"
              >
                <PlusIcon size={14} />
              </button>
            }
          >
            Workspaces
          </SidebarSection>

          {state.workspaces.length === 0 ? (
            <p className="text-muted-foreground px-3 py-1.5 text-[13px]">
              None yet. Add a folder to begin.
            </p>
          ) : (
            state.workspaces.map((workspace) => {
              const selected = workspace.id === state.selectedWorkspace?.id;
              const shut = collapsed[workspace.id] === true;
              return (
                <div key={workspace.id} className="flex flex-col gap-0.5">
                  <SidebarRow
                    data-row="workspace"
                    glyph={
                      <span
                        className="size-2.5 rounded-full"
                        style={{ background: workspaceColor(workspace.id) }}
                      />
                    }
                    active={selected}
                    title={workspace.path}
                    onClick={() => {
                      state.selectWorkspace(workspace);
                      if (selected) {
                        setCollapsed((before) => ({
                          ...before,
                          [workspace.id]: !shut,
                        }));
                      }
                    }}
                    trailing={
                      <ChevronRightIcon
                        size={14}
                        className={cn(
                          "text-muted-foreground shrink-0 transition-transform",
                          !shut && "rotate-90",
                        )}
                      />
                    }
                  >
                    {workspace.name}
                  </SidebarRow>

                  {selected && !shut
                    ? state.sessions.map((session) => (
                        <SidebarRow
                          key={session.id}
                          data-row="session"
                          className={ROW_LANE_NESTED}
                          active={session.id === state.selectedSession?.id}
                          onClick={() => state.selectSession(session)}
                          trailing={
                            <span className="text-muted-foreground shrink-0 text-[11px]">
                              {relativeAge(session.time.updated)}
                            </span>
                          }
                        >
                          {session.title}
                        </SidebarRow>
                      ))
                    : null}

                  {selected && !shut && state.sessions.length === 0 ? (
                    <p className="text-muted-foreground ps-6 pe-2 py-1 text-[12px]">
                      No sessions yet.
                    </p>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </SidebarBody>

      <SidebarFooterArea>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="hover:bg-sidebar-accent flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 ps-3 pe-2 text-start transition-colors"
          >
            <GlyphSlot>
              <CloudIcon size={16} className="text-muted-foreground" />
            </GlyphSlot>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">Sign in</span>
              <span className="text-muted-foreground block truncate text-[11px]">
                Sync with Rantai Cloud
              </span>
            </span>
          </button>
          <Link
            href="/settings"
            aria-label="Settings"
            title="Settings"
            className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors"
          >
            <SettingsIcon size={16} />
          </Link>
        </div>
      </SidebarFooterArea>
    </>
  );
}
