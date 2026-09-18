"use client";

import { useMemo, useState } from "react";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { Model } from "../tauri";
import { modelLabel, sameModel } from "./model";

/**
 * Picks the model a new conversation will run on.
 *
 * It is a picker for the *next* session, not for this one. A session's model is
 * fixed when the engine creates it and there is no way to change it afterwards —
 * `prompt` accepts a model and ignores it, and no route updates a session. So
 * when a conversation is open this shows what that conversation runs on, plainly
 * labelled, and choosing a different one changes what the next `New task` gets.
 * A control that silently did nothing would be worse than one that says what it
 * does.
 *
 * Models are grouped by provider because the list is long — 59 on the
 * development machine — and a provider is how anyone actually narrows it down.
 */
export type ModelPickerProps = {
  models: Model[];
  /** What the open session runs on, or what the next one will. */
  value: Model | null;
  onChange: (model: Model) => void;
  /** True while a conversation is open, which makes the choice apply to the next one. */
  locked?: boolean;
  disabled?: boolean;
};

export function ModelPicker(props: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matching = needle
      ? props.models.filter((m) =>
          `${m.providerID}/${m.id}`.toLowerCase().includes(needle),
        )
      : props.models;

    const byProvider = new Map<string, Model[]>();
    for (const model of matching) {
      const list = byProvider.get(model.providerID);
      if (list) list.push(model);
      else byProvider.set(model.providerID, [model]);
    }
    return [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [props.models, search]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            disabled={props.disabled || props.models.length === 0}
            title={
              props.locked
                ? "This conversation is fixed to this model. Choosing another changes what the next task starts with."
                : "The model a new task starts with"
            }
            className="text-muted-foreground hover:bg-dls-hover hover:text-foreground inline-flex h-9 min-w-0 items-center gap-1 rounded-md px-2 text-[13px] transition-colors disabled:pointer-events-none disabled:opacity-50"
          >
            <span className="truncate">{modelLabel(props.value)}</span>
            <ChevronDownIcon size={14} className="shrink-0" />
          </button>
        }
      />
      <PopoverContent align="start" className="w-80 p-0">
        <div className="border-border flex items-center gap-2 border-b px-3">
          <SearchIcon size={14} className="text-muted-foreground shrink-0" />
          <input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search models…"
            className="placeholder:text-muted-foreground h-9 w-full bg-transparent text-[13px] outline-hidden"
          />
        </div>

        {props.locked ? (
          <p className="text-muted-foreground border-border border-b px-3 py-2 text-[11px] leading-[15px]">
            This conversation stays on its own model. A new one will start with
            what you pick here.
          </p>
        ) : null}

        <div className="max-h-72 overflow-y-auto py-1">
          {groups.length === 0 ? (
            <p className="text-muted-foreground px-3 py-6 text-center text-[13px]">
              Nothing matches.
            </p>
          ) : (
            groups.map(([provider, list]) => (
              <div key={provider}>
                <div className="text-muted-foreground px-3 pt-2 pb-1 text-[11px]">
                  {provider}
                </div>
                {list.map((model) => {
                  const chosen = sameModel(model, props.value);
                  return (
                    <button
                      key={`${model.providerID}/${model.id}`}
                      type="button"
                      onClick={() => {
                        props.onChange(model);
                        setOpen(false);
                      }}
                      className={cn(
                        "hover:bg-dls-hover flex w-full items-center gap-2 px-3 py-1.5 text-start text-[13px] transition-colors",
                        chosen && "text-foreground font-medium",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{model.id}</span>
                      {chosen ? (
                        <CheckIcon size={14} className="text-primary shrink-0" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
