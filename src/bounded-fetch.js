// Keep upstream HTTP requests shorter than the watch interval. Cloudflare cron
// invocations can otherwise remain open for minutes on an unresponsive origin.
export async function boundedFetch(url, options = {}) {
  const { timeoutMs: requestedTimeoutMs, ...fetchOptions } = options;
  const timeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
    ? requestedTimeoutMs
    : 12000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`HTTP timeout after ${timeoutMs}ms: ${url}`)), timeoutMs);
  const upstreamSignal = fetchOptions.signal;
  const abortFromUpstream = () => controller.abort(upstreamSignal.reason);
  if (upstreamSignal?.aborted) abortFromUpstream();
  else upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  try {
    const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
    // The caller may read the body after fetch resolves. The timeout should
    // also cover that read, so release the timer when the body is consumed.
    if (!response.body || response.status === 204 || response.status === 205 || response.status === 304) {
      clearTimeout(timer);
      return response;
    }
    const reader = response.body.getReader();
    const stream = new ReadableStream({
      async pull(out) {
        try {
          const { done, value } = await reader.read();
          if (done) { clearTimeout(timer); out.close(); }
          else out.enqueue(value);
        } catch (error) { clearTimeout(timer); out.error(error); }
      },
      async cancel(reason) {
        clearTimeout(timer);
        await reader.cancel(reason);
      },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    clearTimeout(timer);
    throw error;
  } finally {
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}
