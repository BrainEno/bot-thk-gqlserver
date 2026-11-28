export const extractBearerToken = (
    authorization: string | null | undefined
): string | null => {
    if (!authorization) return null
    const match = /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/i.exec(authorization.trim())
    return match?.[1] ?? null
}
