// @ts-check

/**
 * @typedef {import("../generated/api").CartTransformRunInput} CartTransformRunInput
 * @typedef {import("../generated/api").CartTransformRunResult} CartTransformRunResult
 */

/**
 * @type {CartTransformRunResult}
 */
const NO_CHANGES = {
  operations: [],
};

/**
 * @param {CartTransformRunInput} input
 * @returns {CartTransformRunResult}
 */
export function cartTransformRun(input) {
  const utmSource = input.cart.attribute?.value;

  if (!utmSource) {
    return NO_CHANGES;
  }

  const metafieldValue = input.cartTransform?.metafield?.value;

  if (!metafieldValue) {
    return NO_CHANGES;
  }

  let rules;
  try {
    rules = JSON.parse(metafieldValue);
  } catch {
    return NO_CHANGES;
  }

  // Find active rule matching this utm_source
  /** @type {{ utmSource: string, discountType: string, discountValue: number, isActive: boolean, title: string, productIds: string[] } | undefined} */
  const matchingRule = rules.find(
    (/** @type {any} */ rule) => rule.utmSource === utmSource && rule.isActive
  );

  if (!matchingRule) {
    return NO_CHANGES;
  }

  const targetProductIds = matchingRule.productIds || [];
  const hasProductFilter = targetProductIds.length > 0;

  const operations = [];

  for (const line of input.cart.lines) {
    // If rule targets specific products, check if this line's product matches
    if (hasProductFilter) {
      const merchandise = line.merchandise;
      if (!merchandise || !("product" in merchandise)) {
        continue;
      }
      const productId = merchandise.product?.id;
      if (!productId || !targetProductIds.includes(productId)) {
        continue;
      }
    }

    const originalPrice = parseFloat(line.cost.amountPerQuantity.amount);

    let newPrice;
    if (matchingRule.discountType === "percentage") {
      newPrice = originalPrice * (1 - matchingRule.discountValue / 100);
    } else {
      // fixed amount discount
      newPrice = Math.max(0, originalPrice - matchingRule.discountValue);
    }

    // Round to 2 decimal places
    newPrice = Math.round(newPrice * 100) / 100;

    if (newPrice < originalPrice) {
      operations.push({
        lineUpdate: {
          cartLineId: line.id,
          title: matchingRule.title || undefined,
          price: {
            adjustment: {
              fixedPricePerUnit: {
                amount: newPrice.toString(),
              },
            },
          },
        },
      });
    }
  }

  if (operations.length === 0) {
    return NO_CHANGES;
  }

  return { operations };
}
