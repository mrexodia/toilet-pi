import { createOrchestratorToken, getConnectionAuthFromToken, validateOrchestratorGrant, verifyAdminSessionCookie } from './auth.js'

export async function issueOrchestratorToken(secret: string, cookie: string | null, originAllowed: boolean, body: string) {
  if (!originAllowed) return { status: 403, data: { message: 'Forbidden origin' } }
  if ((await verifyAdminSessionCookie(secret, cookie))?.kind !== 'admin') return { status: 401, data: { message: 'Admin login required' } }
  let grant: unknown
  try { grant = JSON.parse(body) } catch { return { status: 400, data: { message: 'Invalid JSON' } } }
  if (new TextEncoder().encode(body).length > 16384 || !validateOrchestratorGrant(grant)) {
    return { status: 400, data: { message: 'Invalid grant: require subject, read scope, expiry 1..86400 seconds; optional hostIds/sessionIds' } }
  }
  return { status: 200, data: { token: await createOrchestratorToken(secret, grant) } }
}

/** Header-only scoped credentials: never put them into URLs/access logs. */
export async function authenticateOrchestratorHeader(secret: string, header: string) {
  if (!header.startsWith('Bearer ')) return null
  const auth = await getConnectionAuthFromToken(secret, header.slice(7))
  return auth?.kind === 'orchestrator' ? auth : null
}
