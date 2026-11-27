import {
    createHmac,
    randomBytes,
    scrypt as scryptCallback,
    timingSafeEqual,
} from 'crypto'
const COST = 1 << 15
const BLOCK_SIZE = 8
const PARALLELISM = 1
const KEY_LENGTH = 64
const SALT_LENGTH = 16
const MAX_MEMORY = 64 * 1024 * 1024

export interface PasswordRecord {
    hashed_password: string
    salt?: string
    save(): Promise<unknown>
}

const deriveKey = (password: string, salt: Buffer): Promise<Buffer> =>
    new Promise((resolve, reject) => {
        scryptCallback(
            password,
            salt,
            KEY_LENGTH,
            {
                N: COST,
                r: BLOCK_SIZE,
                p: PARALLELISM,
                maxmem: MAX_MEMORY,
            },
            (error, derivedKey) => {
                if (error) reject(error)
                else resolve(derivedKey as Buffer)
            }
        )
    })

export const hashPassword = async (password: string): Promise<string> => {
    const salt = randomBytes(SALT_LENGTH)
    const derivedKey = await deriveKey(password, salt)

    return [
        'scrypt',
        COST,
        BLOCK_SIZE,
        PARALLELISM,
        salt.toString('hex'),
        derivedKey.toString('hex'),
    ].join('$')
}

const verifyScryptHash = async (
    password: string,
    encodedHash: string
): Promise<boolean> => {
    const [algorithm, cost, blockSize, parallelism, saltHex, keyHex, ...extra] =
        encodedHash.split('$')

    if (
        algorithm !== 'scrypt' ||
        extra.length !== 0 ||
        Number(cost) !== COST ||
        Number(blockSize) !== BLOCK_SIZE ||
        Number(parallelism) !== PARALLELISM ||
        !/^[a-f\d]{32}$/i.test(saltHex ?? '') ||
        !/^[a-f\d]{128}$/i.test(keyHex ?? '')
    ) {
        return false
    }

    const expected = Buffer.from(keyHex, 'hex')
    const actual = await deriveKey(password, Buffer.from(saltHex, 'hex'))

    return timingSafeEqual(actual, expected)
}

const verifyLegacyHmac = (
    password: string,
    salt: string | undefined,
    encodedHash: string
): boolean => {
    if (!salt || !/^[a-f\d]{40}$/i.test(encodedHash)) return false

    const expected = Buffer.from(encodedHash, 'hex')
    const actual = createHmac('sha1', salt).update(password).digest()

    return timingSafeEqual(actual, expected)
}

/**
 * Verify a stored password and transparently upgrade the legacy HMAC-SHA1
 * representation after a successful login. New passwords use Node's scrypt.
 */
export const verifyPassword = async (
    record: PasswordRecord,
    password: string
): Promise<boolean> => {
    if (!password || !record.hashed_password) return false

    if (record.hashed_password.startsWith('scrypt$')) {
        return verifyScryptHash(password, record.hashed_password)
    }

    if (!verifyLegacyHmac(password, record.salt, record.hashed_password)) {
        return false
    }

    record.hashed_password = await hashPassword(password)
    record.salt = ''
    await record.save()
    return true
}

export const setPassword = async (
    record: PasswordRecord,
    password: string
): Promise<void> => {
    record.hashed_password = await hashPassword(password)
    record.salt = ''
}
