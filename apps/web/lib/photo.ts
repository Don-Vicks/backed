// Product photo upload from the browser: shrink first (phone photos are several MB), then POST the bytes.
export const MAX_PHOTO_SIDE = 1200;
const MAX_UPLOAD_BYTES = 1_400_000; // under the server's 1.5 MB limit
const MAX_PICK_BYTES = 25_000_000; // refuse absurd files before decoding them
export const PHOTO_ACCEPT = "image/png,image/jpeg,image/webp";

// Decodes the photo, scales its longest side to MAX_PHOTO_SIDE and re-encodes it as JPEG
// (a transparent PNG gets a white background). The browser applies the camera's rotation.
export async function shrinkPhoto(file: File): Promise<Blob> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error("Use a PNG, JPEG or WebP photo.");
  if (file.size > MAX_PICK_BYTES) throw new Error("That file is too large. Pick a photo under 25 MB.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("Couldn’t read that photo. Try a different file.");
  }
  try {
    const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Your browser can’t process photos.");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.85, 0.7, 0.55]) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.size <= MAX_UPLOAD_BYTES) return blob;
    }
    throw new Error("That photo is too detailed to upload. Try a smaller one.");
  } finally {
    bitmap.close();
  }
}

// Uploads a shrunk photo; resolves to the public URL the campaign will use.
export async function uploadPhoto(blob: Blob): Promise<string> {
  const res = await fetch("/api/images", { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
  const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !data.url) throw new Error(data.error ?? `Upload failed (${res.status})`);
  return data.url;
}
