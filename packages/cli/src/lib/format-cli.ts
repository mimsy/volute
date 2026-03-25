/** Whether output should be compact (mind context). */
export const isCompact = () => !!process.env.VOLUTE_MIND;

/** Format a DB timestamp as HH:MM */
export function compactTime(dateStr: string): string {
  const d = new Date(dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Format a DB timestamp as YYYY-MM-DD HH:MM */
export function compactDateTime(dateStr: string): string {
  const d = new Date(dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${h}:${min}`;
}
