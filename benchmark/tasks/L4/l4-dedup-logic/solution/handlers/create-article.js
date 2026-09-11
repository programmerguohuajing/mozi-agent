import { nonEmptyString, validateRequest } from './validate-request.js';

export function createArticle(body) {
  return validateRequest(body, {
    title: nonEmptyString('title 不能为空'),
    content: nonEmptyString('content 不能为空'),
  });
}
