import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/// Carried over from OpenWork unchanged. Every one of the 44 UI components
/// depends on it, so it keeps its name and its home.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
