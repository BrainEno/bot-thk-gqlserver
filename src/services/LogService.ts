import { AsyncLocalStorage } from 'node:async_hooks'
import pino from 'pino'

export const requestContext = new AsyncLocalStorage<{ requestId: string }>()

const createLogger = () => {
    const options: pino.LoggerOptions = {
        level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'development' ? 'debug' : 'info'),
        timestamp: pino.stdTimeFunctions.isoTime,
        mixin: () => {
            const context = requestContext.getStore()
            return context ? { requestId: context.requestId } : {}
        },
        redact: {
            paths: [
                'password',
                '*.password',
                'token',
                '*.token',
                'authorization',
                'req.headers.authorization',
                'req.headers.cookie',
                'res.headers.set-cookie',
            ],
            censor: '[REDACTED]',
        },
    }

    if (process.env.NODE_ENV === 'development') {
        return pino(
            options,
            pino.transport({
                target: 'pino-pretty',
                options: {
                    colorize: true,
                    translateTime: 'SYS:standard',
                    ignore: 'pid,hostname',
                },
            })
        )
    }

    // Production writes structured JSON to stdout so container platforms can
    // collect and index logs. No temporary files or pretty-print worker needed.
    return pino(options)
}

export const logger = createLogger()

export const logFailure = (event: string, error: unknown): void => {
    const errorName = error instanceof Error ? error.name : 'UnknownError'
    logger.error({ event, errorName }, 'Operation failed')
}

export class LogService {
    log(event: string, fields: Record<string, unknown> = {}): void {
        logger.info({ event, ...fields })
    }

    warn(event: string, fields: Record<string, unknown> = {}): void {
        logger.warn({ event, ...fields })
    }

    error(event: string, fields: Record<string, unknown> = {}): void {
        logger.error({ event, ...fields })
    }
}
