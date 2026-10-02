import { createSemaphore } from './semaphore';

// bcryptjs is pure JavaScript: every hash or compare holds the event loop for
// the length of the cost factor. Unbounded, a flood of logins (each burning a
// compare, known email or not) stalls every other request on the process. A few
// at a time keeps the server answering; the rest wait briefly, then give up.
export class BcryptBusyError extends Error {
  constructor() {
    super('password check is busy; try again shortly');
    this.name = 'BcryptBusyError';
  }
}

export const withBcryptSlot = createSemaphore(4, 5_000, () => new BcryptBusyError());
