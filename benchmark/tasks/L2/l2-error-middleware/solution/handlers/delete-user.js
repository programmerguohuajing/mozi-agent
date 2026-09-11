import { HttpError } from './http-error.js';

export async function deleteUser(ctx) {
  if (!ctx.params.id) {
    throw new HttpError(404, 'NOT_FOUND', 'missing id');
  }
  return { status: 200, body: { deleted: ctx.params.id } };
}
