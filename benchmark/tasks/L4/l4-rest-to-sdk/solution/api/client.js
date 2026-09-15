import { ResourceClient } from '../sdk/index.js';

const BASE_URL = 'https://api.example.com/v1';
const TOKEN = 'tok_123';

const users = new ResourceClient({ baseUrl: BASE_URL, token: TOKEN, resource: 'users' });
const orders = new ResourceClient({ baseUrl: BASE_URL, token: TOKEN, resource: 'orders' });

export function getUser(id) {
  return users.get(`/${id}`);
}

export function listUsers() {
  return users.get('');
}

export function createOrder(payload) {
  return orders.post('', payload);
}

export function updateOrder(id, payload) {
  return orders.put(`/${id}`, payload);
}
