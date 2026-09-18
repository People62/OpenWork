"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckIcon, SearchIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { commands, unwrap, type Provider, type Providers } from "../tauri";

/**
 * Where an API key is entered, and the reason this screen is not a leaf.
 *
 * The engine reads its credentials from OpenCode's own store, which until now
 * only `opencode auth login` ever wrote. On a machine where that was never run
 * there is nothing but OpenCode's free tier — and the free tier refuses to be
 * used outside the OpenCode application, so the first turn fails with an empty
 * answer and no explanation. Release 1 promises one conversation with OpenCode;
 * without this screen that promise held only on a developer's own machine.
 *
 * Adding or removing a key restarts the engine. It works out its providers and
 * models when it starts and never again — measured — so without the restart a
 * key that was just accepted would connect nothing the model picker could see.
 */
export function ProviderSettings() {
  const [catalogue, setCatalogue] = useState<Providers | null>(null);
  const [search, setSearch] = useState("");
  const [entering, setEntering] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setCatalogue(await unwrap(commands.listProviders()));
    } catch (e) {
      // The commonest cause by far is that no workspace is open, so no engine is
      // running. Saying that outright beats a transport error nobody can act on.
      setError(
        e instanceof Error && /not running/i.test(e.message)
          ? "No engine is running. Open a workspace first — providers are read from the engine."
          : e instanceof Error
            ? e.message
            : String(e),
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connected = useMemo(
    () => new Set(catalogue?.connected ?? []),
    [catalogue],
  );

  const { linked, rest } = useMemo(() => {
    const all = catalogue?.all ?? [];
    const needle = search.trim().toLowerCase();
    const matching = needle
      ? all.filter((p) => `${p.id} ${p.name}`.toLowerCase().includes(needle))
      : all;
    return {
      linked: matching.filter((p) => connected.has(p.id)),
      rest: matching.filter((p) => !connected.has(p.id)),
    };
  }, [catalogue, connected, search]);

  async function run(id: string, work: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await work();
      // The key is dropped the moment it has been handed over. Nothing here
      // keeps one, and nothing reads one back — the engine does not return them
      // and this screen never asks.
      setKey("");
      setEntering(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {error ? (
        <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-[13px]">
          {error}
        </div>
      ) : null}

      <div className="border-dls-border bg-dls-surface flex items-center gap-2 rounded-xl border px-3">
        <SearchIcon size={14} className="text-muted-foreground shrink-0" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={`Search ${catalogue?.all.length ?? 0} providers…`}
          className="placeholder:text-muted-foreground h-9 w-full bg-transparent text-[13px] outline-hidden"
        />
      </div>

      {linked.length > 0 ? (
        <Section label="Connected">
          {linked.map((provider) => (
            <Row
              key={provider.id}
              provider={provider}
              connected
              busy={busy === provider.id}
              onDisconnect={() =>
                void run(provider.id, () =>
                  unwrap(commands.disconnectProvider(provider.id)),
                )
              }
            />
          ))}
        </Section>
      ) : null}

      <Section label={linked.length > 0 ? "Everything else" : "Providers"}>
        {rest.length === 0 ? (
          <p className="text-muted-foreground px-1 py-3 text-[13px]">
            Nothing matches.
          </p>
        ) : (
          rest.map((provider) => (
            <Row
              key={provider.id}
              provider={provider}
              busy={busy === provider.id}
              entering={entering === provider.id}
              value={key}
              onValue={setKey}
              onOpen={() => {
                setEntering(provider.id);
                setKey("");
              }}
              onCancel={() => {
                setEntering(null);
                setKey("");
              }}
              onSave={() =>
                void run(provider.id, () =>
                  unwrap(commands.connectProvider(provider.id, key)),
                )
              }
            />
          ))
        )}
      </Section>
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="text-muted-foreground text-[11px] font-semibold tracking-[0.15em] uppercase">
        {label}
      </div>
      <div className="border-dls-border bg-dls-surface divide-border divide-y rounded-2xl border">
        {children}
      </div>
    </div>
  );
}

function Row({
  provider,
  connected,
  busy,
  entering,
  value,
  onValue,
  onOpen,
  onCancel,
  onSave,
  onDisconnect,
}: {
  provider: Provider;
  connected?: boolean;
  busy?: boolean;
  entering?: boolean;
  value?: string;
  onValue?: (value: string) => void;
  onOpen?: () => void;
  onCancel?: () => void;
  onSave?: () => void;
  onDisconnect?: () => void;
}) {
  return (
    <div className="p-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-foreground flex items-center gap-2 text-[13px] font-medium">
            <span className="truncate">{provider.name || provider.id}</span>
            {connected ? (
              <CheckIcon size={13} className="text-primary shrink-0" />
            ) : null}
          </div>
          {/* The environment variable is named for people who would rather set
              one than hand a key to an application. Both routes work; the engine
              reads either. */}
          {provider.env?.length ? (
            <div className="text-muted-foreground mt-0.5 truncate font-mono text-[11px]">
              {provider.env.join(" · ")}
            </div>
          ) : null}
        </div>

        {connected ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onDisconnect}>
            {busy ? "Removing…" : "Remove"}
          </Button>
        ) : entering ? null : (
          <Button variant="outline" size="sm" disabled={busy} onClick={onOpen}>
            Add key
          </Button>
        )}
      </div>

      {entering ? (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (value?.trim()) onSave?.();
          }}
        >
          {/* `type="password"` so a key is not left on screen over someone's
              shoulder, and `autoComplete="off"` so the browser never offers to
              keep it. */}
          <Input
            autoFocus
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value ?? ""}
            onChange={(event) => onValue?.(event.target.value)}
            placeholder="API key"
            className="h-8 flex-1 font-mono text-[13px]"
          />
          <Button type="submit" size="sm" disabled={busy || !value?.trim()}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Cancel"
            disabled={busy}
            onClick={onCancel}
          >
            <XIcon size={14} />
          </Button>
        </form>
      ) : null}

      {busy ? (
        <p className={cn("text-muted-foreground mt-2 text-[11px]")}>
          Restarting the engine so its model list catches up.
        </p>
      ) : null}
    </div>
  );
}
