export const normalizeUserId = (value: unknown): string | null => {
    if (typeof value === 'string') return value || null
    if (value && typeof value === 'object' && 'toString' in value) {
        const normalized = value.toString()
        return normalized && normalized !== '[object Object]' ? normalized : null
    }
    return null
}

export const areUserIdsEqual = (left: unknown, right: unknown): boolean => {
    const leftId = normalizeUserId(left)
    const rightId = normalizeUserId(right)
    return Boolean(leftId && rightId && leftId === rightId)
}
