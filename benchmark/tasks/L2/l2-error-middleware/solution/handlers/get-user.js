import { HttpError } from './http-error.js';

export async function getUser(ctx) {
  if (ctx.params.id === 'boom') {
    throw new Error('db exploded');
  }
  return { status: 200, body: { id: ctx.params.id, name: 'alice' } };
}
