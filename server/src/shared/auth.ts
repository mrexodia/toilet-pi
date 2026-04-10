const encoder = new TextEncoder()

export function hasMatchingToken(expectedToken: string, candidateToken: string | null | undefined): boolean {
  const expected = encoder.encode(String(expectedToken || ''))
  const candidate = encoder.encode(String(candidateToken || ''))

  if (expected.length === 0 || expected.length !== candidate.length) {
    return false
  }

  let diff = 0
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected[i] ^ candidate[i]
  }

  return diff === 0
}

export function getTokenFromRequestUrl(requestUrl: string): string | null {
  try {
    return new URL(requestUrl).searchParams.get('token')
  } catch {
    return null
  }
}

export function isAuthorizedRequest(requestUrl: string, expectedToken: string): boolean {
  return hasMatchingToken(expectedToken, getTokenFromRequestUrl(requestUrl))
}
