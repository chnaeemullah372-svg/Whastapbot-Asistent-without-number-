import type { ReactNode } from "react";

/** WhatsApp-style avatar: the contact/group's real profile photo when we have
 *  one cached, otherwise an initials circle (or a custom icon, e.g. for
 *  groups) — never a blank space. */
export function Avatar({
  url,
  label,
  size = 48,
  textClassName = "",
  icon,
}: {
  url?: string | null;
  label?: string;
  size?: number;
  textClassName?: string;
  icon?: ReactNode;
}) {
  const style = { width: size, height: size };
  if (url) {
    return (
      <img
        src={url}
        alt=""
        className="rounded-full object-cover shrink-0 bg-card"
        style={style}
      />
    );
  }
  if (icon) {
    return (
      <div
        className="rounded-full bg-emerald-600/20 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0"
        style={style}
      >
        {icon}
      </div>
    );
  }
  const initial = label ? label.charAt(0).toUpperCase() : "?";
  return (
    <div
      className={`rounded-full bg-primary/20 text-primary flex items-center justify-center font-semibold shrink-0 ${textClassName}`}
      style={style}
    >
      {initial}
    </div>
  );
}
