import { Service } from 'typedi';
import pino from 'pino';
import type { Logger } from 'pino';
import { tmpdir } from 'os';
import { join } from 'path';

const file = join(tmpdir(), `pino-${process.pid}`);
const transport = pino.transport({
  targets: [
    {
      level: 'warn',
      target: 'pino/file',
      options: {
        destination: file,
      },
    },
    {
      level: 'info',
      target: 'pino-pretty',
      options: {
        colorize: true,
      },
    },
  ],
});
const logger: Logger = pino(transport);
@Service()
export class LogService {
  log(msg: string) {
    if (logger) logger.info(msg);
  }

  warn(msg: string) {
    logger.warn(msg);
  }

  error(msg: string) {
    logger.error(msg);
  }
}
