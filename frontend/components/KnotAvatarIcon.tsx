"use client";

// "Neurolink" icon shown next to the assistant's name in the chat list
// (replaces the old three-ribbon knot mark).
//
// - Idle (`active` false): a fully static neural-net glyph — a hub node
//   with five linked nodes around it. No motion at all.
// - Generating (`active` true): pulses fire outward from the hub along
//   each link in a staggered sequence and the nodes light up as the
//   pulse reaches them, like signals travelling a small neural network —
//   synced to the same "is this message currently streaming" flag as
//   before. Stops instantly and snaps back to the static glyph the
//   moment `active` goes false.
//
// Colour: everything is drawn with `currentColor`, which resolves to
// the theme's text colour (white on the dark theme, black on the light
// theme via --visiyon-text) — no hardcoded palette, so it always reads
// correctly regardless of theme.
const LINKS = [
  { x: 50, y: 18 },
  { x: 79.6, y: 34.5 },
  { x: 79.6, y: 65.5 },
  { x: 50, y: 82 },
  { x: 20.4, y: 65.5 },
];

export default function KnotAvatarIcon({
  size = 16,
  active = false,
  className = "",
}: {
  size?: number;
  active?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`visiyon-neuro-icon ${active ? "visiyon-neuro-icon--active" : ""} ${className}`}
      style={{ width: size, height: size, color: "currentColor" }}
      role="img"
      aria-label={active ? "Jean, generating" : "Jean"}
    >
      <svg viewBox="0 0 100 100" width={size} height={size} fill="none">
        {LINKS.map((n, i) => (
          <line
            key={`link-${i}`}
            className="visiyon-neuro-link"
            style={{ animationDelay: `${i * 0.18}s` }}
            x1={50}
            y1={50}
            x2={n.x}
            y2={n.y}
            stroke="currentColor"
            strokeWidth={4}
            strokeLinecap="round"
          />
        ))}
        {LINKS.map((n, i) => (
          <circle
            key={`node-${i}`}
            className="visiyon-neuro-node"
            style={{ animationDelay: `${i * 0.18}s` }}
            cx={n.x}
            cy={n.y}
            r={7}
            fill="currentColor"
          />
        ))}
        <circle className="visiyon-neuro-hub" cx={50} cy={50} r={11} fill="currentColor" />
      </svg>
    </span>
  );
}
