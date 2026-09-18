"use client";

import { useState } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  LifeBuoyIcon,
  MessageCircleIcon,
  SettingsIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { AppShell } from "../shell/app-shell";
import { ProviderSettings } from "./providers";
import { SECTIONS, GROUP_LABELS, findSection, sectionsIn } from "./sections";
import {
  SidebarBody,
  SidebarRow,
  SidebarRowLink,
  SidebarSection,
} from "../shell/sidebar";

/// Settings, laid out the way OpenWork lays them out: a rail on the left that
/// leaves the app, and an overview in the middle that is itself a way in.
///
/// The overview exists because the rail alone hides what settings there are
/// behind eleven words. Cards give each one a sentence.
///
/// Sections are in one array and both surfaces read it, so the rail and the
/// grid cannot come to disagree about what exists.
export default function Settings() {
  // Tabs rather than routes: `output: 'export'` would make each one a directory
  // on disk, and there is no deep link into a settings tab that anything needs.
  const [openId, setOpenId] = useState<string | null>(null);
  const open = openId ? findSection(openId) : undefined;

  return (
    <AppShell
      title={
        <span className="flex items-baseline gap-2">
          Settings
          {open ? (
            <span className="text-muted-foreground text-[12px]">{open.title}</span>
          ) : null}
        </span>
      }
      sidebar={
        <SidebarBody>
          <div className="flex flex-col gap-0.5">
            <SidebarRowLink glyph={<ArrowLeftIcon />} href="/">
              Back to app
            </SidebarRowLink>
            <SidebarRow
              glyph={<SettingsIcon />}
              active={openId === null}
              onClick={() => setOpenId(null)}
            >
              Settings
            </SidebarRow>
          </div>

          {(["workspace", "global", "cloud"] as const).map((group) => (
            <div key={group} className="mt-2 flex flex-col gap-0.5">
              <SidebarSection>{GROUP_LABELS[group]}</SidebarSection>
              {sectionsIn(group).map((section) => (
                <SidebarRow
                  key={section.id}
                  glyph={<section.icon />}
                  active={openId === section.id}
                  onClick={() => setOpenId(section.id)}
                >
                  {section.title}
                </SidebarRow>
              ))}
            </div>
          ))}
        </SidebarBody>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-10">
        {open ? (
          <div className="mx-auto w-full max-w-3xl space-y-3">
            <h2 className="font-heading text-foreground text-[20px] leading-[26px] font-semibold tracking-[-0.02em]">
              {open.title}
            </h2>
            <p className="text-muted-foreground text-[13px]">{open.description}</p>
            {open.id === "ai" ? (
              <ProviderSettings />
            ) : (
              <div className="border-dls-border bg-dls-surface rounded-2xl border p-4">
                <p className="text-muted-foreground text-[13px]">{open.pending}</p>
              </div>
            )}
          </div>
        ) : (
          <Overview onOpen={setOpenId} />
        )}
      </div>
    </AppShell>
  );
}

function Overview({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-8">
      <div className="space-y-1.5">
        <h2 className="font-heading text-foreground text-[24px] leading-[30px] font-semibold tracking-[-0.02em]">
          Settings
        </h2>
        <p className="text-muted-foreground text-[13px]">Overview of all settings</p>
      </div>

      {(["workspace", "global", "cloud"] as const).map((group) => (
        <div key={group} className="space-y-3">
          <div className="text-muted-foreground text-[11px] font-semibold tracking-[0.15em] uppercase">
            {GROUP_LABELS[group]}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {sectionsIn(group).map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => onOpen(section.id)}
                className="border-dls-border bg-dls-surface hover:bg-dls-hover flex items-center gap-3 rounded-2xl border p-4 text-left transition-colors"
              >
                <div className="border-dls-border bg-dls-hover flex size-9 shrink-0 items-center justify-center rounded-xl border">
                  <section.icon size={16} className="text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-foreground text-[13px] font-medium">
                    {section.title}
                  </div>
                  <div className="text-muted-foreground text-[11px]">
                    {section.description}
                  </div>
                </div>
                <ArrowRightIcon size={14} className="text-muted-foreground shrink-0" />
              </button>
            ))}
          </div>
        </div>
      ))}

      <div className="space-y-3">
        <div className="text-muted-foreground text-[11px] font-semibold tracking-[0.15em] uppercase">
          Help
        </div>
        <div className="border-dls-border bg-dls-surface space-y-3 rounded-2xl border p-4">
          <div>
            <div className="flex items-center gap-2">
              <LifeBuoyIcon size={14} className="text-muted-foreground" />
              <div className="text-foreground text-[13px] font-medium">
                Help shape Rantai
              </div>
            </div>
            <p className="text-muted-foreground mt-1 max-w-[58ch] text-[11px]">
              Tell us what feels great and what feels rough. Feedback goes
              straight to the team and helps us prioritise what ships next.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm">
              <MessageCircleIcon size={12} />
              Send feedback
              <ArrowUpRightIcon size={11} />
            </Button>
            <Button variant="outline" size="sm">
              Report an issue
              <ArrowUpRightIcon size={11} />
            </Button>
          </div>
        </div>
      </div>

      <p className="text-muted-foreground text-[11px]">
        {SECTIONS.length} sections. Most are still waiting on the backend behind
        them — each one says which.
      </p>
    </div>
  );
}
