// @ts-check

/**
 * @typedef {import("../generated/api").CartTransformRunInput} CartTransformRunInput
 * @typedef {import("../generated/api").CartTransformRunResult} CartTransformRunResult
 */

/**
 * Cart Transform function — currently a no-op.
 * Discount logic is handled by native Shopify discount codes
 * auto-applied via the UTM theme snippet.
 *
 * @param {CartTransformRunInput} input
 * @returns {CartTransformRunResult}
 */
export function cartTransformRun(input) {
  return { operations: [] };
}
