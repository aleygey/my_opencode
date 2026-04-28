/**
 * Wraps a `createResource` fetcher so it returns the previous result reference
 * when the new payload is structurally identical to the previous one.
 *
 * Background: `createResource` keeps the previous value during refetch, but
 * once the new fetch resolves it always swaps in the new object — even when
 * the bytes match exactly. Downstream `createMemo` / `<For>` consumers then
 * re-key on a brand-new array of brand-new objects, recreating DOM rows on
 * every poll. With this wrapper, identical responses keep their reference,
 * Solid's referential-equality on the underlying signal short-circuits, and
 * the polling becomes invisible to the UI.
 *
 * Equality is by `JSON.stringify` of the full payload — adequate for the
 * small (sub-MB) JSON shapes we poll. If the shape ever grows, swap to a
 * structural compare (e.g., dequal) without changing the call sites.
 */
export function stableFetcher<K, V>(fn: (key: K) => Promise<V>): (key: K) => Promise<V> {
  let prevKey: string | undefined
  let prevVal: V | undefined
  return async (key: K) => {
    const next = await fn(key)
    let nextKey: string
    try {
      nextKey = JSON.stringify(next)
    } catch {
      // Non-serializable result — give up on dedup, hand the new value through.
      prevKey = undefined
      prevVal = next
      return next
    }
    if (prevVal !== undefined && nextKey === prevKey) return prevVal
    prevKey = nextKey
    prevVal = next
    return next
  }
}
