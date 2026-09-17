"use client";

import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";
import type { Message } from "../tauri";

/**
 * A conversation on screen.
 *
 * Two shapes, and they are deliberately not symmetrical: what you said is a
 * bubble hugged to the right, what the assistant said is plain text running the
 * full column. Giving both a bubble makes a transcript look like a chat app and
 * makes long answers — which is what most answers are — read as a wall.
 *
 * Column is 3xl with a 40px gutter at desktop width, the same as the reference.
 */
export type ConversationProps = {
  messages: Message[];
  /** Tokens arriving for a turn that has no saved message yet. */
  streaming?: string | null;
};

export function Conversation(props: ConversationProps) {
  const end = useRef<HTMLDivElement>(null);

  // Follow the bottom as the answer grows. `block: "end"` rather than
  // `scrollIntoView()` bare, which also scrolls the nearest horizontal parent.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [props.messages.length, props.streaming]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto py-6">
      <div className="flex flex-col gap-6">
        {props.messages.map((message) => (
          <MessageRow key={message.id} role={message.role} content={message.content} />
        ))}
        {props.streaming ? (
          <MessageRow role="assistant" content={props.streaming} streaming />
        ) : null}
      </div>
      <div ref={end} />
    </div>
  );
}

function MessageRow({
  role,
  content,
  streaming,
}: {
  role: string;
  content: string;
  streaming?: boolean;
}) {
  const mine = role === "user";
  return (
    <div
      data-message-role={role}
      className={cn(
        "mx-auto flex w-full max-w-3xl flex-col gap-2 px-2 md:px-10",
        mine ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "text-[14px] leading-6 whitespace-pre-wrap",
          mine
            ? "bg-muted text-foreground max-w-[85%] rounded-3xl px-4 py-2.5 sm:max-w-[75%]"
            : "text-foreground w-full",
        )}
      >
        {content}
        {streaming ? (
          <span className="bg-foreground ms-0.5 inline-block h-4 w-[2px] animate-pulse align-[-2px]" />
        ) : null}
      </div>
    </div>
  );
}
