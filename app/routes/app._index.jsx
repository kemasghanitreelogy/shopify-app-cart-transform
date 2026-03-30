import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const totalRules = await prisma.discountRule.count({ where: { shop } });
  const activeRules = await prisma.discountRule.count({
    where: { shop, isActive: true },
  });
  const rules = await prisma.discountRule.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  return { totalRules, activeRules, rules };
};

export default function Index() {
  const { totalRules, activeRules, rules } = useLoaderData();

  return (
    <s-page heading="Cart Transform Dashboard">
      <s-button slot="primary-action" href="/app/discount-rules">
        Manage Rules
      </s-button>

      <s-section heading="Overview">
        <s-stack direction="inline" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="tight">
              <s-text variant="subdued">Total Rules</s-text>
              <s-text fontWeight="bold" fontSize="large">
                {totalRules}
              </s-text>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="tight">
              <s-text variant="subdued">Active Rules</s-text>
              <s-text fontWeight="bold" fontSize="large">
                {activeRules}
              </s-text>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="tight">
              <s-text variant="subdued">Inactive Rules</s-text>
              <s-text fontWeight="bold" fontSize="large">
                {totalRules - activeRules}
              </s-text>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      {rules.length > 0 && (
        <s-section heading="Recent Rules">
          <s-stack direction="block" gap="base">
            {rules.map((rule) => (
              <s-box
                key={rule.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background={rule.isActive ? "surface" : "subdued"}
              >
                <s-stack direction="inline" gap="base" align="center">
                  <s-stack direction="block" gap="tight" style={{ flex: 1 }}>
                    <s-text fontWeight="bold">
                      {rule.title || rule.utmSource}
                    </s-text>
                    <s-text variant="subdued">
                      utm_source={rule.utmSource} →{" "}
                      {rule.discountType === "percentage"
                        ? `${rule.discountValue}% off`
                        : `$${rule.discountValue} off`}
                    </s-text>
                  </s-stack>
                  <s-badge tone={rule.isActive ? "success" : "default"}>
                    {rule.isActive ? "Active" : "Inactive"}
                  </s-badge>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}

      {rules.length === 0 && (
        <s-section>
          <s-empty-state heading="Welcome to Cart Transform">
            <s-paragraph>
              Create UTM-based discount rules to dynamically adjust prices for
              visitors from different traffic sources. No product duplication, no
              frontend flicker — prices are transformed server-side before
              checkout.
            </s-paragraph>
            <s-button href="/app/discount-rules" variant="primary">
              Create your first rule
            </s-button>
          </s-empty-state>
        </s-section>
      )}

      <s-section slot="aside" heading="How Cart Transform Works">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <s-text fontWeight="bold">1.</s-text> A visitor arrives at your
            store with a UTM parameter (e.g. ?utm_source=instagram).
          </s-paragraph>
          <s-paragraph>
            <s-text fontWeight="bold">2.</s-text> The theme snippet captures
            the UTM source and saves it as a cart attribute.
          </s-paragraph>
          <s-paragraph>
            <s-text fontWeight="bold">3.</s-text> At checkout, the Shopify
            Function reads the cart attribute and your discount rules.
          </s-paragraph>
          <s-paragraph>
            <s-text fontWeight="bold">4.</s-text> Matching prices are
            transformed instantly — no flicker, no product duplication.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Quick Setup">
        <s-unordered-list>
          <s-list-item>
            <s-link href="/app/discount-rules">Create discount rules</s-link>{" "}
            for your UTM sources
          </s-list-item>
          <s-list-item>
            Add the theme snippet (see Discount Rules page)
          </s-list-item>
          <s-list-item>
            Enable the Cart Transform in Shopify Admin → Settings → Cart
            Transforms
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
