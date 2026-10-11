"use client";

import { useRef, useState } from "react";
import { ImagePlus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IMAGE_URL_MAX_CHARS } from "@preorder/core/src/campaign-input";
import { PHOTO_ACCEPT, shrinkPhoto, uploadPhoto } from "@/lib/photo";

// The maker's product photo: pick a file (shrunk and uploaded), or paste a link instead.
// `onChange(url, previewSrc)`: previewSrc is a local copy to show at once (null when only a link is known).
export function PhotoField({ image, previewSrc, onChange }: { image: string; previewSrc: string | null; onChange: (url: string, previewSrc: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const shown = previewSrc ?? (image.trim() || null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await shrinkPhoto(file);
      const url = await uploadPhoto(blob);
      onChange(url, URL.createObjectURL(blob));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = ""; // picking the same file again should still fire
    }
  }

  return (
    <div className="grid gap-3">
      <span className="text-sm font-medium">
        Product photo <span className="text-muted-foreground">(optional, but campaigns with one do better)</span>
      </span>

      <input ref={input} id="photo-file" type="file" accept={PHOTO_ACCEPT} className="sr-only" onChange={(e) => pick(e.target.files?.[0])} disabled={busy} />

      {shown ? (
        <div className="flex items-center gap-4 rounded-lg border border-border p-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- local preview or the maker's own upload */}
          <img src={shown} alt="Your product photo" className="size-20 rounded-md object-cover" />
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => input.current?.click()}>
              {busy ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
              {busy ? "Uploading…" : "Replace photo"}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => onChange("", null)}>
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <label
          htmlFor="photo-file"
          className="flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground has-[:focus-visible]:ring-2"
        >
          {busy ? <Loader2 aria-hidden="true" className="size-6 animate-spin" /> : <ImagePlus aria-hidden="true" className="size-6" />}
          <span className="font-medium text-foreground">{busy ? "Uploading…" : "Add a product photo"}</span>
          <span>{busy ? "Shrinking it first, so it loads fast." : "PNG, JPEG or WebP. Phone photos are fine."}</span>
        </label>
      )}

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <details>
        <summary className="cursor-pointer text-sm text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">Or paste a link to a photo instead</summary>
        <div className="mt-2 grid gap-2">
          <Input type="url" inputMode="url" aria-label="Photo link" placeholder="https://…" maxLength={IMAGE_URL_MAX_CHARS} value={previewSrc ? "" : image} onChange={(e) => onChange(e.target.value, null)} />
        </div>
      </details>
    </div>
  );
}
