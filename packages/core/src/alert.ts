// Operator alerts: a JSON POST to ALERT_WEBHOOK_URL (a Slack or Discord incoming webhook works: it carries
// both `text` and `content`). Fire-and-forget and throttled per key, so an outage that fails every request
// sends one message, not thousands. It never throws: an alert that cannot be sent is logged and dropped.
export const ALERT_THROTTLE_MS = 5 * 60_000
const lastSent = new Map<string, number>()

export function alertWebhook(env: NodeJS.ProcessEnv = process.env): URL | null {
  const raw = env.ALERT_WEBHOOK_URL?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    return url.protocol === 'https:' || (local && url.protocol === 'http:') ? url : null
  } catch {
    return null
  }
}

export async function sendAlert(key: string, message: string, details: Record<string, unknown> = {}, now = Date.now()): Promise<boolean> {
  const url = alertWebhook()
  if (!url) return false
  if (now - (lastSent.get(key) ?? 0) < ALERT_THROTTLE_MS) return false
  lastSent.set(key, now)
  if (lastSent.size > 200) for (const [k, t] of lastSent) if (now - t > ALERT_THROTTLE_MS) lastSent.delete(k)
  const text = `[backed ${process.env.NETWORK ?? ''}] ${message}`.trim()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, content: text, key, details }),
      signal: AbortSignal.timeout(5000),
    })
    return res.ok
  } catch (e) {
    console.error(JSON.stringify({ event: 'alert', error: e instanceof Error ? e.message : String(e) }))
    return false
  }
}

export const resetAlertThrottle = () => lastSent.clear()
