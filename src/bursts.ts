/** The most events one key published inside any `windowSeconds` span: how many, and how long they actually took. */
export function burstOf(timestamps: number[], windowSeconds: number): { events: number; seconds: number } {
  const ts = [...timestamps].sort((a, b) => a - b)
  let best = 0, bestSpan = 0
  for (let i = 0, j = 0; i < ts.length; i++) {
    while (ts[i]! - ts[j]! > windowSeconds) j++
    if (i - j + 1 > best) { best = i - j + 1; bestSpan = ts[i]! - ts[j]! }
  }
  return { events: best, seconds: bestSpan }
}
