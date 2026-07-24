const retryStatus = (status) => status === 429 || status >= 500

const timeout = (ms, parent) => {
  const ctrl = new AbortController()
  let timer = setTimeout(() => ctrl.abort(), ms)
  const abort = () => ctrl.abort()
  parent?.addEventListener("abort", abort, { once: true })
  return { signal: ctrl.signal, pause: () => { clearTimeout(timer); timer = undefined }, close: () => { if (timer) clearTimeout(timer); parent?.removeEventListener("abort", abort) } }
}

const category = (error) => error.name === "AbortError" ? "timeout" : "network"

const describe = (error) => ({
  category: category(error),
  name: error.name,
  message: error.message,
  code: error.code,
  syscall: error.syscall,
  cause: error.cause?.message ?? error.cause?.code,
})

export async function attempt(candidates, maxAttempts, totalMs, run) {
  const started = Date.now()
  const errors = []
  for (const candidate of candidates.slice(0, maxAttempts)) {
    const remain = totalMs - (Date.now() - started)
    if (remain <= 0) break
    const clock = timeout(remain)
    try {
      const result = await run(candidate, clock)
      if (result.ok || !retryStatus(result.status)) return { result, candidate, errors }
      errors.push({ candidate: candidate.id, category: `http-${result.status}`, status: result.status })
    } catch (error) {
      if (error.nonRetry) throw error
       errors.push({ candidate: candidate.id, ...describe(error) })
    } finally { clock.close() }
  }
  const error = new Error("All model gateway candidates failed")
  error.attempts = errors
  throw error
}

export const isRetryable = (status) => retryStatus(status)
