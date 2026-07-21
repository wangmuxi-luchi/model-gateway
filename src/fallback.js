const retryStatus = (status) => status === 429 || status >= 500

const timeout = (ms, parent) => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  const abort = () => ctrl.abort()
  parent?.addEventListener("abort", abort, { once: true })
  return { signal: ctrl.signal, close: () => { clearTimeout(timer); parent?.removeEventListener("abort", abort) } }
}

const category = (error) => error.name === "AbortError" ? "timeout" : "network"

export async function attempt(candidates, maxAttempts, totalMs, run) {
  const started = Date.now()
  const errors = []
  for (const candidate of candidates.slice(0, maxAttempts)) {
    const remain = totalMs - (Date.now() - started)
    if (remain <= 0) break
    const clock = timeout(remain)
    try {
      const result = await run(candidate, clock.signal)
      if (result.ok || !retryStatus(result.status)) return { result, candidate, errors }
      errors.push({ candidate: candidate.id, category: `http-${result.status}`, status: result.status })
    } catch (error) {
      if (error.nonRetry) throw error
      errors.push({ candidate: candidate.id, category: category(error) })
    } finally { clock.close() }
  }
  const error = new Error("All model gateway candidates failed")
  error.attempts = errors
  throw error
}

export const isRetryable = (status) => retryStatus(status)
