import { createLogger } from './logger.js';

const log = createLogger('service-b');

export function refundSeat(seat) {
  log.info(`refunding seat ${seat}`);
  if (seat < 1) {
    log.error(`invalid seat: ${seat}`);
    return false;
  }
  return true;
}
