import { createLogger } from './logger.js';

const log = createLogger('service-a');

export function reserveSeat(seat) {
  log.info(`reserving seat ${seat}`);
  if (seat < 1) {
    log.error(`invalid seat: ${seat}`);
    return false;
  }
  return true;
}
