const encoder = new TextEncoder()

export const ADMIN_COOKIE_NAME = 'toilet-pi-admin'
export const ADMIN_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365

export interface AdminSessionClaims {
  kind: 'admin-session'
  iat: number
  exp?: number
}

export interface MachineTokenClaims {
  kind: 'machine'
  machineId: string
  iat: number
  exp?: number
}

export type SignedTokenClaims = AdminSessionClaims | MachineTokenClaims

export type ConnectionAuth =
  | { kind: 'admin' }
  | { kind: 'machine'; machineId: string }

export interface CookieOptions {
  maxAge?: number
  path?: string
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

const hmacKeys = new Map<string, Promise<CryptoKey>>()

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

export async function createAdminSessionToken(
  signingSecret: string,
  options: { expiresInSeconds?: number | null } = {},
): Promise<string> {
  return signToken(signingSecret, {
    kind: 'admin-session',
    iat: getUnixTimeNow(),
    exp: normalizeExpiry(options.expiresInSeconds),
  })
}

export async function createMachineToken(
  signingSecret: string,
  machineId: string,
  options: { expiresInSeconds?: number | null } = {},
): Promise<string> {
  return signToken(signingSecret, {
    kind: 'machine',
    machineId,
    iat: getUnixTimeNow(),
    exp: normalizeExpiry(options.expiresInSeconds),
  })
}

export async function getConnectionAuthFromToken(
  expectedAdminToken: string,
  candidateToken: string | null | undefined,
): Promise<ConnectionAuth | null> {
  const token = String(candidateToken || '').trim()
  if (!token) return null

  const claims = await verifySignedToken(expectedAdminToken, token)
  if (!claims) return null

  if (claims.kind === 'admin-session') {
    return { kind: 'admin' }
  }

  if (claims.kind === 'machine' && claims.machineId) {
    return { kind: 'machine', machineId: claims.machineId }
  }

  return null
}

export async function verifyAdminSessionCookie(
  expectedAdminToken: string,
  cookieHeader: string | null | undefined,
  cookieName = ADMIN_COOKIE_NAME,
): Promise<ConnectionAuth | null> {
  const token = parseCookieValue(cookieHeader, cookieName)
  if (!token) return null

  const claims = await verifySignedToken(expectedAdminToken, token)
  if (!claims || claims.kind !== 'admin-session') return null
  return { kind: 'admin' }
}

export function parseCookieValue(
  cookieHeader: string | null | undefined,
  cookieName: string,
): string | null {
  const header = String(cookieHeader || '')
  if (!header || !cookieName) return null

  for (const part of header.split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex <= 0) continue
    const name = trimmed.slice(0, separatorIndex).trim()
    if (name !== cookieName) continue
    const rawValue = trimmed.slice(separatorIndex + 1)
    try {
      return decodeURIComponent(rawValue)
    } catch {
      return rawValue
    }
  }

  return null
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  parts.push(`Path=${options.path || '/'}`)

  if (typeof options.maxAge === 'number') {
    const maxAge = Math.max(0, Math.floor(options.maxAge))
    parts.push(`Max-Age=${maxAge}`)
    parts.push(`Expires=${new Date(Date.now() + maxAge * 1000).toUTCString()}`)
  }

  if (options.httpOnly !== false) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`)

  return parts.join('; ')
}

export function clearCookie(name: string, options: CookieOptions = {}): string {
  return serializeCookie(name, '', {
    path: options.path || '/',
    httpOnly: options.httpOnly,
    secure: options.secure,
    sameSite: options.sameSite,
    maxAge: 0,
  })
}

export async function signToken(signingSecret: string, claims: SignedTokenClaims): Promise<string> {
  const header = {
    alg: 'HS256',
    typ: 'JWT',
  }

  const encodedHeader = encodeBase64Url(JSON.stringify(header))
  const encodedPayload = encodeBase64Url(JSON.stringify(claims))
  const input = `${encodedHeader}.${encodedPayload}`
  const signature = await signHmacSha256(signingSecret, input)
  return `${input}.${encodeBase64UrlBytes(signature)}`
}

export async function verifySignedToken(
  signingSecret: string,
  token: string,
): Promise<SignedTokenClaims | null> {
  const normalized = String(token || '').trim()
  if (!normalized) return null

  const parts = normalized.split('.')
  if (parts.length !== 3) return null

  const [encodedHeader, encodedPayload, encodedSignature] = parts
  if (!encodedHeader || !encodedPayload || !encodedSignature) return null

  let header: any
  let claims: any
  let signatureBytes: Uint8Array
  try {
    header = JSON.parse(decodeBase64Url(encodedHeader))
    claims = JSON.parse(decodeBase64Url(encodedPayload))
    signatureBytes = decodeBase64UrlBytes(encodedSignature)
  } catch {
    return null
  }

  if (header?.alg !== 'HS256' || header?.typ !== 'JWT') return null

  const verified = await verifyHmacSha256(
    signingSecret,
    `${encodedHeader}.${encodedPayload}`,
    signatureBytes,
  )
  if (!verified) return null

  if (!claims || typeof claims !== 'object') return null
  if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat)) return null
  if (claims.exp != null && (!Number.isFinite(claims.exp) || getUnixTimeNow() > claims.exp)) {
    return null
  }

  if (claims.kind === 'admin-session') {
    return {
      kind: 'admin-session',
      iat: claims.iat,
      exp: typeof claims.exp === 'number' ? claims.exp : undefined,
    }
  }

  if (claims.kind === 'machine' && typeof claims.machineId === 'string' && claims.machineId) {
    return {
      kind: 'machine',
      machineId: claims.machineId,
      iat: claims.iat,
      exp: typeof claims.exp === 'number' ? claims.exp : undefined,
    }
  }

  return null
}

function normalizeExpiry(expiresInSeconds: number | null | undefined): number | undefined {
  if (typeof expiresInSeconds !== 'number' || !Number.isFinite(expiresInSeconds)) {
    return undefined
  }
  return getUnixTimeNow() + Math.max(1, Math.floor(expiresInSeconds))
}

function getUnixTimeNow(): number {
  return Math.floor(Date.now() / 1000)
}

async function getHmacKey(signingSecret: string): Promise<CryptoKey> {
  const cacheKey = String(signingSecret || '')
  let keyPromise = hmacKeys.get(cacheKey)
  if (!keyPromise) {
    keyPromise = globalThis.crypto.subtle.importKey(
      'raw',
      encoder.encode(cacheKey),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    )
    hmacKeys.set(cacheKey, keyPromise)
  }
  return keyPromise
}

async function signHmacSha256(signingSecret: string, input: string): Promise<Uint8Array> {
  const key = await getHmacKey(signingSecret)
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(input))
  return new Uint8Array(signature)
}

async function verifyHmacSha256(
  signingSecret: string,
  input: string,
  signatureBytes: Uint8Array,
): Promise<boolean> {
  const key = await getHmacKey(signingSecret)
  return globalThis.crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes as unknown as BufferSource,
    encoder.encode(input),
  )
}

function encodeBase64Url(value: string): string {
  return encodeBase64UrlBytes(encoder.encode(value))
}

function decodeBase64Url(value: string): string {
  return new TextDecoder().decode(decodeBase64UrlBytes(value))
}

function encodeBase64UrlBytes(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64UrlBytes(value: string): Uint8Array {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/')
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
  return decodeBase64(`${normalized}${padding}`)
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }

  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function decodeBase64(value: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(value, 'base64'))
  }

  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
