// Fallback Blink icon for campaigns without an image. Generated so a rename stays a one-constant change.
import { BRAND } from "@preorder/core/src/brand";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export function GET() {
  const name = xml(BRAND);
  // Meteora's palette: the curve in its gold-orange-violet gradient on indigo-black.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="${name}">
  <defs>
    <linearGradient id="g" x1="64" y1="420" x2="448" y2="96" gradientUnits="userSpaceOnUse">
      <stop stop-color="#6E45FF"/>
      <stop offset="0.6" stop-color="#F54B00"/>
      <stop offset="1" stop-color="#F5BD00"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="#0D0D13"/>
  <path d="M64 400 C 180 400, 260 330, 448 112" fill="none" stroke="url(#g)" stroke-width="22" stroke-linecap="round"/>
  <circle cx="448" cy="112" r="26" fill="url(#g)"/>
  <text x="64" y="160" font-family="Plus Jakarta Sans, Inter, Helvetica, Arial, sans-serif" font-weight="700" font-size="88" letter-spacing="-3" fill="#F9F9FB">${name}</text>
</svg>
`;
  return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
}
