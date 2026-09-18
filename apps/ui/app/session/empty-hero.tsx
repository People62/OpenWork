"use client";

import { useState } from "react";

import { Composer } from "./composer";

/**
 * The first thing an empty workspace shows: the real composer, centred, with
 * four things it could be asked to do underneath.
 *
 * Copied from the reference down to the measurements — 640px column, a 24/30
 * heading at -0.02em, 13px sub, then a 2×2 grid of 13px/12px cards. It is the
 * screen OpenWork is recognised by.
 */
export type Suggestion = {
  title: string;
  description: string;
  prompt: string;
};

const SUGGESTIONS: Suggestion[] = [
  {
    title: "Summarize my week",
    description: "Pull highlights from email and calendar.",
    prompt:
      "Summarize my week: pull the highlights from my connected email and calendar and give me a short digest of what happened and what needs my attention.",
  },
  {
    title: "Clean up a spreadsheet",
    description: "Drop in a CSV and describe the result you want.",
    prompt:
      "Create a sample CSV file with 20 rows of fake customer data (name, email, company, revenue). Then show me a summary of the data.",
  },
  {
    title: "Draft a document",
    description: "Reports, emails, or briefs from a few bullet points.",
    prompt:
      "Draft a one-page project brief. Ask me for the bullet points you need, then turn them into a clear, well-structured document.",
  },
  {
    title: "Automate a web task",
    description: "Use the built-in browser for repetitive steps.",
    prompt:
      "Open craigslist.org in the browser and search for couches for sale. Show me the top 5 results with prices.",
  },
];

export type EmptyHeroProps = {
  /** Given the written prompt. The caller creates the session. */
  onRunTask: (prompt: string) => void;
  busy?: boolean;
  /** The model picker, rendered inside the composer's control row. */
  modelPicker?: React.ReactNode;
};

export function EmptyHero(props: EmptyHeroProps) {
  const [draft, setDraft] = useState("");

  return (
    <div className="mx-auto w-full max-w-[640px] space-y-6 px-4 sm:px-6">
      <div className="space-y-1.5 text-center">
        <h2 className="font-heading text-foreground text-[24px] leading-[30px] font-semibold tracking-[-0.02em]">
          What do you need done?
        </h2>
        <p className="text-muted-foreground text-[13px]">
          Describe it in plain language
        </p>
      </div>

      <Composer
        value={draft}
        onChange={setDraft}
        onSend={() => {
          const prompt = draft.trim();
          if (!prompt || props.busy) return;
          setDraft("");
          props.onRunTask(prompt);
        }}
        disabled={props.busy}
        modelPicker={props.modelPicker}
        autoFocus
      />

      <div className="grid gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion.title}
            type="button"
            className="border-border bg-background hover:bg-accent rounded-xl border p-3.5 text-left transition-colors"
            onClick={() => setDraft(suggestion.prompt)}
          >
            <div className="text-foreground truncate text-[13px] font-medium">
              {suggestion.title}
            </div>
            <div className="text-muted-foreground mt-0.5 line-clamp-2 text-[12px] leading-[17px]">
              {suggestion.description}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
