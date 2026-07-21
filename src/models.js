export async function listModels(candidate, key, signal) {
  const response = await fetch(`${candidate.baseUrl}/models`, { headers: { accept: "application/json", authorization: key ? `Bearer ${key}` : undefined }, signal })
  if (!response.ok) throw Object.assign(new Error(`Models request failed (${response.status})`), { status: response.status })
  const data = await response.json()
  if (!Array.isArray(data.data)) throw new Error("Upstream returned an invalid models response")
  return data.data.filter((item) => item && typeof item.id === "string").map((item) => ({ id: item.id, object: item.object ?? "model", ownedBy: item.owned_by }))
}
