// What settings there are, in the order they are shown.
//
// One list, read by both the left rail and the overview grid. In the reference
// those are two separate surfaces that must not drift, and keeping one array is
// the cheapest way to make drifting impossible.

import {
  CloudIcon,
  CogIcon,
  FolderLockIcon,
  LibraryIcon,
  PaintbrushIcon,
  RefreshCcwIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TerminalIcon,
  UserRoundIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";

export type SettingsGroup = "workspace" | "global" | "cloud";

export type SettingsSection = {
  id: string;
  group: SettingsGroup;
  title: string;
  description: string;
  icon: LucideIcon;
  /** What the placeholder says until the backend behind it exists. */
  pending: string;
};

export const SECTIONS: SettingsSection[] = [
  {
    id: "preferences",
    group: "workspace",
    title: "Preferences",
    description: "Default model, reasoning, and compaction.",
    icon: CogIcon,
    pending: "Model defaults live in the engine, which is wired but not yet asked for its settings.",
  },
  {
    id: "permissions",
    group: "workspace",
    title: "Permissions",
    description: "Authorized folders and file access.",
    icon: FolderLockIcon,
    pending: "Approvals are deliberately out of Release 1 — a leaf on the same backbone.",
  },
  {
    id: "library",
    group: "workspace",
    title: "Library",
    description: "Skills, agents, and commands.",
    icon: LibraryIcon,
    pending: "Skills and commands are out of Release 1.",
  },
  {
    id: "advanced",
    group: "workspace",
    title: "Advanced",
    description: "Runtime, engine, and developer options.",
    icon: WrenchIcon,
    pending: "The engine controls that exist today are on the diagnostics page.",
  },
  {
    id: "ai",
    group: "global",
    title: "AI Providers",
    description: "Connect services that provide AI models.",
    icon: SparklesIcon,
    pending: "",
  },
  {
    id: "appearance",
    group: "global",
    title: "Appearance",
    description: "Theme, font size, and display.",
    icon: PaintbrushIcon,
    pending: "Theme follows the system until this is built.",
  },
  {
    id: "environment",
    group: "global",
    title: "Environment",
    description: "Environment variables and paths.",
    icon: TerminalIcon,
    pending: "The engine inherits the environment the application was started in.",
  },
  {
    id: "updates",
    group: "global",
    title: "Updates",
    description: "App version and update channel.",
    icon: RefreshCcwIcon,
    pending: "The update check works today and is on the diagnostics page.",
  },
  {
    id: "recovery",
    group: "global",
    title: "Recovery",
    description: "Reset onboarding and clear data.",
    icon: ShieldCheckIcon,
    pending: "Nothing here yet. The database is a single file and can be removed by hand.",
  },
  {
    id: "cloud",
    group: "cloud",
    title: "Cloud",
    description: "Rantai Cloud account and organization.",
    icon: CloudIcon,
    pending: "Sign-in reaches the native half; the grant exchange is not built yet.",
  },
  {
    id: "account",
    group: "cloud",
    title: "Account",
    description: "Who you are signed in as.",
    icon: UserRoundIcon,
    pending: "Nothing to show until sign-in completes.",
  },
];

export const GROUP_LABELS: Record<SettingsGroup, string> = {
  workspace: "Workspace",
  global: "Global",
  cloud: "Cloud",
};

export function sectionsIn(group: SettingsGroup): SettingsSection[] {
  return SECTIONS.filter((section) => section.group === group);
}

export function findSection(id: string): SettingsSection | undefined {
  return SECTIONS.find((section) => section.id === id);
}
