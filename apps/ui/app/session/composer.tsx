"use client";

import { useEffect, useRef } from "react";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  PaperclipIcon,
  PlusIcon,
  SquareIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The box a task is written in.
 *
 * The reference builds this on Lexical so it can carry `@file` mentions, `/`
 * commands and attachment chips inside the text. None of those exist yet on our
 * side, and a rich-text editor with nothing rich to hold is 1300 lines of
 * nothing. What is here is the shape: an 18px-rounded panel, the text flush to
 * the top, and one control row underneath — tools, attach, model, send.
 *
 * The send control is a single circular slot that becomes Stop while a turn is
 * running. Two buttons that are never both usable would only ask the eye to
 * pick between them.
 */
export type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  /** A turn is running. */
  busy?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** What the model picker reads. */
  modelLabel?: string;
  onPickModel?: () => void;
  autoFocus?: boolean;
};

export function Composer(props: ComposerProps) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const canSend = props.value.trim().length > 0 && !props.disabled;

  // Grow with the text up to a ceiling, then scroll. Measured from `scrollHeight`
  // after a reset, because a textarea never reports a height smaller than the one
  // it already has.
  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, [props.value]);

  return (
    <div className="border-dls-border bg-dls-surface relative rounded-[18px] border">
      <textarea
        ref={textarea}
        value={props.value}
        autoFocus={props.autoFocus}
        rows={1}
        placeholder={props.placeholder ?? "Describe your task…"}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends, Shift+Enter breaks the line. IME composition has to be
          // let through untouched or every Japanese and Chinese confirmation
          // would send the message instead of accepting the candidate.
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
            return;
          }
          event.preventDefault();
          if (props.busy || !canSend) return;
          props.onSend();
        }}
        className="placeholder:text-muted-foreground max-h-60 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14px] leading-[21px] outline-hidden"
      />

      <div className="flex items-center gap-1 px-2 pb-2">
        <ComposerTool label="Tools">
          <PlusIcon size={16} />
        </ComposerTool>
        <ComposerTool label="Attach files">
          <PaperclipIcon size={16} />
        </ComposerTool>

        {props.modelLabel ? (
          <button
            type="button"
            onClick={props.onPickModel}
            className="text-muted-foreground hover:bg-dls-hover hover:text-foreground inline-flex h-9 min-w-0 items-center gap-1 rounded-md px-2 text-[13px] transition-colors"
          >
            <span className="truncate">{props.modelLabel}</span>
            <ChevronDownIcon size={14} className="shrink-0" />
          </button>
        ) : null}

        <div className="ms-auto flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={props.busy ? props.onStop : canSend ? props.onSend : undefined}
            disabled={props.busy ? !props.onStop : !canSend}
            aria-label={props.busy ? "Stop" : "Run task"}
            title={props.busy ? "Stop" : "Run task"}
            className={cn(
              "inline-flex size-9 shrink-0 items-center justify-center rounded-full transition-colors",
              props.busy || canSend
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-muted text-muted-foreground",
            )}
          >
            {props.busy ? (
              <SquareIcon size={12} fill="currentColor" />
            ) : (
              <ArrowUpIcon size={15} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function ComposerTool({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="text-muted-foreground hover:bg-dls-hover hover:text-foreground inline-flex size-9 shrink-0 items-center justify-center rounded-md transition-colors"
    >
      {children}
    </button>
  );
}
