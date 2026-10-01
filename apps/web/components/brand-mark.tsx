import { useId } from "react";

// Backed's mark: a pre-order curve rising to its goal, drawn in Meteora's gradient.
export function BrandMark({ className }: { className?: string }) {
  const id = `g${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`; // safe inside url(#…)
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={id} x1="3" y1="29" x2="29" y2="3" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6E45FF" />
          <stop offset="0.62" stopColor="#F54B00" />
          <stop offset="1" stopColor="#F5BD00" />
        </linearGradient>
      </defs>
      <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="9" className="fill-card stroke-border" strokeWidth="1.5" />
      <path d="M7 24.5C14 24.5 19 20.5 23.6 10" fill="none" stroke={`url(#${id})`} strokeWidth="3" strokeLinecap="round" />
      <circle cx="24" cy="9" r="3" fill={`url(#${id})`} />
    </svg>
  );
}
