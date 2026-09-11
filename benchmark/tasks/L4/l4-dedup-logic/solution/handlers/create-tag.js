import { nonEmptyString, validateRequest } from './validate-request.js';

export function createTag(body) {
  return validateRequest(body, {
    name: nonEmptyString('name 不能为空'),
  });
}
