"use client";

import { useMemo, useSyncExternalStore } from "react";

// A launch the wallet may have sent but the server has not listed yet. Kept in localStorage so a
// reload, a closed tab or a failed confirm can still finish the listing instead of launching twice.
export type PendingLaunch = { pool: string; signature?: string; name: string; at: number };

const KEY = "pending-launch";
const EVENT = "pending-launch-change";

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setPendingLaunch(launch: PendingLaunch | null) {
  try {
    if (launch) localStorage.setItem(KEY, JSON.stringify(launch));
    else localStorage.removeItem(KEY);
  } catch {
    // Private mode: the server's reconcile job still lists a landed pool.
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

export function usePendingLaunch(): PendingLaunch | null {
  const raw = useSyncExternalStore(subscribe, read, () => null);
  return useMemo(() => {
    try {
      return raw ? (JSON.parse(raw) as PendingLaunch) : null;
    } catch {
      return null;
    }
  }, [raw]);
}

// Confirms with backoff (the server itself waits ~15s per attempt). "gone": the server has no such
// build any more, so it never landed. Throws when the last attempt still fails.
export async function confirmLaunch(launch: PendingLaunch, attempts = 4): Promise<"listed" | "gone"> {
  for (let i = 0; ; i++) {
    let error = "Listing failed";
    let retry = true;
    try {
      const res = await fetch("/api/campaigns/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pool: launch.pool, signature: launch.signature }),
      });
      if (res.ok) return "listed";
      if (res.status === 404) return "gone";
      const data = (await res.json().catch(() => ({}))) as { error?: string; retry?: boolean };
      error = data.error ?? `Listing failed (${res.status})`;
      retry = !!data.retry || res.status >= 500;
    } catch {
      error = "Network error while listing";
    }
    if (!retry || i >= attempts - 1) throw new Error(error);
    await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
  }
}
