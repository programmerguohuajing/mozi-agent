import { HttpError } from './http-error.js';

export function withErrorHandling(handler) {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (e) {
      if (e instanceof HttpError) {
        return { status: e.status, body: { error: { code: e.code, message: e.message } } };
      }
      return { status: 500, body: { error: { code: 'INTERNAL', message: String(e?.message ?? e) } } };
    }
  };
}
