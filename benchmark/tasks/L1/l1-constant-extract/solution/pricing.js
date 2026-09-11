const TAX_RATE = 0.08;
const FREE_SHIPPING_THRESHOLD = 3;
const BASE_SHIPPING_FEE = 10;

export function calcPrice(quantity, unitPrice) {
  const subtotal = quantity * unitPrice;
  const shipping = quantity >= FREE_SHIPPING_THRESHOLD ? 0 : BASE_SHIPPING_FEE;
  const tax = (subtotal + shipping) * TAX_RATE;
  return Number((subtotal + shipping + tax).toFixed(2));
}
