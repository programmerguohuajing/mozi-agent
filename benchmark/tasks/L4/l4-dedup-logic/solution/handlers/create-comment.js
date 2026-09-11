import { nonEmptyString, validateRequest } from './validate-request.js';

export function createComment(body) {
  return validateRequest(body, {
    author: nonEmptyString('author 不能为空'),
    text: nonEmptyString('text 不能为空'),
  });
}
