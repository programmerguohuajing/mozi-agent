import { getUser } from './handlers/get-user.js';
import { deleteUser } from './handlers/delete-user.js';
import { withErrorHandling } from './handlers/with-error-handling.js';

export const routes = {
  'GET /users/:id': withErrorHandling(getUser),
  'DELETE /users/:id': withErrorHandling(deleteUser),
};
