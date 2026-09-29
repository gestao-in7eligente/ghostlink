// Small naming helpers of the main screen (pure, tested).

/** Up to two initials of a server name ("Estação Monky" → "EM"). */
export function serverInitials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => [...w][0] ?? '');
  return letters.join('').toLocaleUpperCase() || '?';
}

/** "Ana" → "Ana#2", "Ana#2" → "Ana#3" (spec §7: the interface suggests nickname#2). */
export function suggestNickname(nick: string): string {
  const m = /^(.*)#(\d{1,4})$/u.exec(nick);
  return m ? `${m[1]}#${Number(m[2]) + 1}` : `${nick}#2`;
}
