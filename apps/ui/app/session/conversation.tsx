"use client";

import { useEffect, useRef, useState } from "react";
import { BrainIcon, ChevronRightIcon, WrenchIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Message, Part } from "../tauri";

/**
 * A conversation on screen.
 *
 * Two shapes, and they are deliberately not symmetrical: what you said is a
 * bubble hugged to the right, what the assistant said is plain text running the
 * full column. Giving both a bubble makes a transcript look like a chat app and
 * makes long answers — which is what most answers are — read as a wall.
 *
 * The two kinds are not the same shape in the data either. A user message
 * carries flat `text`; an assistant message carries a list of typed parts, and
 * only some of them are prose. Reasoning and tool calls are folded away rather
 * than dropped: they are how an answer was arrived at, and hiding them entirely
 * makes a wrong answer impossible to account for.
 */
export type ConversationProps = {
  messages: Message[];
  /** Text arriving for a turn the engine has not written down yet. */
  streaming?: string | null;
  /** What was just sent, until the engine's own copy of it comes back. */
  pending?: string | null;
};

export function Conversation(props: ConversationProps) {
  const end = useRef<HTMLDivElement>(null);

  // Follow the bottom as the answer grows. `block: "end"` rather than a bare
  // `scrollIntoView()`, which also scrolls the nearest horizontal parent.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [props.messages.length, props.streaming, props.pending]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto py-6">
      <div className="flex flex-col gap-6">
        {props.messages.map((message) => (
          <MessageRow key={message.id} message={message} />
        ))}
        {props.pending ? <UserBubble text={props.pending} /> : null}
        {props.streaming ? <AssistantText text={props.streaming} streaming /> : null}
      </div>
      <div ref={end} />
    </div>
  );
}

function MessageRow({ message }: { message: Message }) {
  if (message.type === "user") {
    return <UserBubble text={message.text ?? ""} />;
  }

  return (
    <Column align="start" role="assistant">
      {message.content.map((part, index) => (
        <PartRow key={index} part={part} />
      ))}
      {message.error ? <TurnError error={message.error} /> : null}
    </Column>
  );
}

function PartRow({ part }: { part: Part }) {
  switch (part.type) {
    case "text":
      return <div className="text-foreground w-full text-[14px] leading-6 whitespace-pre-wrap">{part.text}</div>;
    case "reasoning":
      return <Folded icon={<BrainIcon size={13} />} label="Thought" body={part.text} />;
    case "tool":
      return (
        <Folded
          icon={<WrenchIcon size={13} />}
          label={part.state.title?.trim() || part.tool}
          status={part.state.status}
          body={part.state.output ?? ""}
        />
      );
    default:
      // `step-start`, `step-finish`, and whatever the engine adds next. They
      // carry no prose, and a placeholder for each would be noise between every
      // paragraph.
      return null;
  }
}

/** Reasoning and tool output: there, closed, one click from being read. */
function Folded({
  icon,
  label,
  status,
  body,
}: {
  icon: React.ReactNode;
  label: string;
  status?: string;
  body: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 rounded-md py-0.5 text-[12px] transition-colors"
      >
        <ChevronRightIcon
          size={13}
          className={cn("shrink-0 transition-transform", open && "rotate-90")}
        />
        {icon}
        <span className="truncate">{label}</span>
        {status && status !== "completed" ? (
          <span className="text-muted-foreground/70">· {status}</span>
        ) : null}
      </button>
      {open && body ? (
        <pre className="text-muted-foreground border-border mt-1 ms-2 max-h-72 overflow-auto border-s ps-3 text-[12px] leading-5 whitespace-pre-wrap">
          {body}
        </pre>
      ) : null}
    </div>
  );
}

/**
 * A turn that ended badly.
 *
 * Shown, not swallowed. The engine reports its own failures inside the message —
 * a refused provider, an interrupted turn — and an answer that simply stops with
 * nothing said is the hardest kind of bug to report.
 */
function TurnError({ error }: { error: unknown }) {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : JSON.stringify(error);
  return (
    <div className="border-destructive/40 bg-destructive/10 text-destructive w-full rounded-lg border px-3 py-2 text-[13px]">
      {message}
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <Column align="end" role="user">
      <div className="bg-muted text-foreground max-w-[85%] rounded-3xl px-4 py-2.5 text-[14px] leading-6 whitespace-pre-wrap sm:max-w-[75%]">
        {text}
      </div>
    </Column>
  );
}

function AssistantText({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <Column align="start" role="assistant">
      <div className="text-foreground w-full text-[14px] leading-6 whitespace-pre-wrap">
        {text}
        {streaming ? (
          <span className="bg-foreground ms-0.5 inline-block h-4 w-[2px] animate-pulse align-[-2px]" />
        ) : null}
      </div>
    </Column>
  );
}

/**
 * The 3xl column with a 40px gutter at desktop width, the reference's measure.
 *
 * `data-message-role` is for the tooling, not the styles: the screenshot and
 * contrast scripts find messages by it, and an attribute they can rely on is
 * cheaper than teaching them this file's class names.
 */
function Column({
  align,
  role,
  children,
}: {
  align: "start" | "end";
  role: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-message-role={role}
      className={cn(
        "mx-auto flex w-full max-w-3xl flex-col gap-2 px-2 md:px-10",
        align === "end" ? "items-end" : "items-start",
      )}
    >
      {children}
    </div>
  );
}
