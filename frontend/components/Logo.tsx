import SparkleAvatarIcon from "./SparkleAvatarIcon";

export default function Logo({ size = 22, showText = false }: { size?: number; showText?: boolean }) {
  // Same sparkle mark used next to the assistant's name in the chat list
  // (see SparkleAvatarIcon) — used here too so the brand mark is
  // consistent everywhere instead of two different icons.
  if (!showText) return <SparkleAvatarIcon size={size} />;
  return (
    <span className="inline-flex items-center gap-2">
      <SparkleAvatarIcon size={size} />
      <span className="font-semibold text-visiyon-text" style={{ fontSize: Math.round(size * 0.8) }}>
        OpenChat
      </span>
    </span>
  );
}
