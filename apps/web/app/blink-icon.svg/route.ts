// Fallback Blink icon for campaigns without an image. Generated so a rename stays a one-constant change.
import { BRAND } from "@preorder/core/src/brand";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export function GET() {
  const name = xml(BRAND);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="${name}">
  <rect width="512" height="512" fill="#0e1622"/>
  <path d="M64 400 C 180 400, 260 330, 448 112" fill="none" stroke="#ec7a3a" stroke-width="22" stroke-linecap="round"/>
  <circle cx="448" cy="112" r="26" fill="#ec7a3a"/>
  <text x="64" y="160" font-family="Georgia, serif" font-size="96" fill="#f3f5f9">${name}</text>
</svg>
`;
  return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
}
