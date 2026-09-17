// The coloured square next to a workspace name.
//
// The colour is hashed from the workspace id, so the same workspace keeps the
// same marker across restarts without anything being stored. Solid colours, no
// gradients — these sit at 16px, where a gradient is just mud.

const COLORS = [
  "#E23B4C",
  "#D44A7A",
  "#D9921A",
  "#1F9A62",
  "#3B6AE0",
  "#E06A28",
  "#A84FA0",
  "#1A9A9C",
  "#6B4FD4",
  "#2A8FBF",
] as const;

export function workspaceInitials(label: string): string {
  const parts = label.trim().split(/[\s/_.-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
}

/** FNV-1a over the id, so the pick is stable and cheap. */
export function workspaceColor(workspaceId: string): string {
  const seed = workspaceId.trim() || "rantai";
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return COLORS[(hash >>> 0) % COLORS.length] ?? COLORS[0];
}
