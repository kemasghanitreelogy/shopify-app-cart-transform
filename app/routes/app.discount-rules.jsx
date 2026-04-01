import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Ensure the metafield definition exists with storefront access
async function ensureMetafieldDefinition(admin) {
  try {
    const checkResponse = await admin.graphql(
      `#graphql
        query {
          metafieldDefinitions(first: 10, ownerType: SHOP, query: "namespace:cart-transform key:utm-rules") {
            nodes { id }
          }
        }`
    );
    const checkData = await checkResponse.json();

    if (checkData.data?.metafieldDefinitions?.nodes?.length > 0) {
      return;
    }

    await admin.graphql(
      `#graphql
        mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition { id }
            userErrors { field message }
          }
        }`,
      {
        variables: {
          definition: {
            name: "UTM Discount Rules",
            namespace: "cart-transform",
            key: "utm-rules",
            type: "json",
            ownerType: "SHOP",
            access: {
              storefront: "PUBLIC_READ",
            },
          },
        },
      }
    );
  } catch (error) {
    console.error("Metafield definition error:", error);
  }
}

// Sync UTM rules to a shop-level metafield (readable from Liquid)
async function syncRulesToShopMetafield(admin, shop) {
  await ensureMetafieldDefinition(admin);

  const rules = await prisma.discountRule.findMany({
    where: { shop },
    select: {
      utmSource: true,
      discountCode: true,
      isActive: true,
    },
  });

  // Get the shop GID
  const shopResponse = await admin.graphql(`#graphql query { shop { id } }`);
  const shopData = await shopResponse.json();
  const shopId = shopData.data?.shop?.id;

  if (!shopId) return { error: "Could not get shop ID" };

  const metafieldResponse = await admin.graphql(
    `#graphql
      mutation SetShopMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id namespace key value }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        metafields: [
          {
            ownerId: shopId,
            namespace: "cart-transform",
            key: "utm-rules",
            type: "json",
            value: JSON.stringify(rules),
          },
        ],
      },
    }
  );

  const data = await metafieldResponse.json();
  return data;
}

// Fetch all active discount codes from Shopify
async function fetchDiscountCodes(admin) {
  const response = await admin.graphql(
    `#graphql
      query {
        codeDiscountNodes(first: 100, query: "status:active") {
          nodes {
            id
            codeDiscount {
              ... on DiscountCodeBasic {
                title
                status
                codes(first: 1) { nodes { code } }
                summary
              }
              ... on DiscountCodeBxgy {
                title
                status
                codes(first: 1) { nodes { code } }
                summary
              }
              ... on DiscountCodeFreeShipping {
                title
                status
                codes(first: 1) { nodes { code } }
                summary
              }
            }
          }
        }
      }`
  );

  const data = await response.json();

  if (data.errors) {
    console.error("Discount fetch errors:", JSON.stringify(data.errors));
    return [];
  }

  const nodes = data.data?.codeDiscountNodes?.nodes || [];

  return nodes
    .map((node) => {
      const d = node.codeDiscount;
      if (!d) return null;
      const code = d.codes?.nodes?.[0]?.code;
      if (!code) return null;
      return {
        id: node.id,
        title: d.title,
        code,
        summary: d.summary || "",
      };
    })
    .filter(Boolean);
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const rules = await prisma.discountRule.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
  });

  const discounts = await fetchDiscountCodes(admin);

  return { rules, shop, discounts };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  try {
    if (intent === "create") {
      const utmSource = formData.get("utmSource")?.toString().trim();
      const discountCode = formData.get("discountCode")?.toString().trim();
      const discountTitle = formData.get("discountTitle")?.toString().trim() || "";

      if (!utmSource || !discountCode) {
        return { error: "UTM Source and Discount Code are required." };
      }

      await prisma.discountRule.upsert({
        where: { shop_utmSource: { shop, utmSource } },
        update: { discountCode, discountTitle, isActive: true },
        create: { shop, utmSource, discountCode, discountTitle },
      });

      await syncRulesToShopMetafield(admin, shop);
      return { success: true, message: "Rule saved and synced." };
    }

    if (intent === "toggle") {
      const id = formData.get("id")?.toString();
      const isActive = formData.get("isActive") === "true";

      await prisma.discountRule.update({
        where: { id },
        data: { isActive },
      });

      await syncRulesToShopMetafield(admin, shop);
      return { success: true, message: `Rule ${isActive ? "activated" : "deactivated"}.` };
    }

    if (intent === "delete") {
      const id = formData.get("id")?.toString();

      await prisma.discountRule.delete({ where: { id } });

      await syncRulesToShopMetafield(admin, shop);
      return { success: true, message: "Rule deleted." };
    }

    if (intent === "sync") {
      const result = await syncRulesToShopMetafield(admin, shop);
      if (result?.error) {
        return { error: result.error };
      }
      return { success: true, message: "Rules synced to storefront." };
    }

    return { error: "Unknown action." };
  } catch (error) {
    console.error("Discount rule action error:", error);
    return { error: error.message || "Something went wrong." };
  }
};

export default function DiscountRules() {
  const { rules, discounts } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [showForm, setShowForm] = useState(false);
  const [utmSource, setUtmSource] = useState("");
  const [selectedDiscount, setSelectedDiscount] = useState(null);

  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show(fetcher.data.message);
      setShowForm(false);
      setUtmSource("");
      setSelectedDiscount(null);
    }
    if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const handleCreate = () => {
    if (!selectedDiscount) {
      shopify.toast.show("Please select a discount.", { isError: true });
      return;
    }
    fetcher.submit(
      {
        intent: "create",
        utmSource,
        discountCode: selectedDiscount.code,
        discountTitle: selectedDiscount.title,
      },
      { method: "POST" }
    );
  };

  const handleToggle = (rule) => {
    fetcher.submit(
      { intent: "toggle", id: rule.id, isActive: (!rule.isActive).toString() },
      { method: "POST" }
    );
  };

  const handleDelete = (rule) => {
    fetcher.submit({ intent: "delete", id: rule.id }, { method: "POST" });
  };

  const handleSync = () => {
    fetcher.submit({ intent: "sync" }, { method: "POST" });
  };

  const themeSnippet = `{% assign utm_rules = shop.metafields['cart-transform']['utm-rules'].value %}
<script>
(function() {
  try {
    var rules = {{ utm_rules | default: '[]' }};
    var params = new URLSearchParams(window.location.search);
    var utm = params.get('utm_source');
    if (utm) sessionStorage.setItem('utm_source', utm);
    var saved = sessionStorage.getItem('utm_source');
    if (saved && !sessionStorage.getItem('utm_applied_' + saved)) {
      var rule = rules.find(function(r) {
        return r.utmSource === saved && r.isActive;
      });
      if (rule && rule.discountCode) {
        sessionStorage.setItem('utm_applied_' + saved, '1');
        window.location.href = '/discount/'
          + encodeURIComponent(rule.discountCode)
          + '?redirect='
          + encodeURIComponent(window.location.pathname + window.location.search);
      }
    }
  } catch(e) { console.error('UTM discount error:', e); }
})();
</script>`;

  return (
    <s-page heading="UTM Discount Rules">
      <s-button slot="primary-action" onClick={() => setShowForm(!showForm)}>
        {showForm ? "Cancel" : "Add Rule"}
      </s-button>
      <s-button
        slot="secondary-action"
        onClick={handleSync}
        {...(isSubmitting ? { loading: true } : {})}
      >
        Sync to Storefront
      </s-button>

      {showForm && (
        <s-section heading="New Rule — Map UTM to Discount">
          <s-stack direction="block" gap="base">
            <s-text-field
              label="UTM Source"
              value={utmSource}
              onInput={(e) => setUtmSource(e.target.value)}
              placeholder="e.g. instagram, tiktok, kesehatanwanita_blog"
            />

            <s-text fontWeight="bold">Select a Shopify Discount Code:</s-text>

            {discounts.length === 0 ? (
              <s-banner tone="warning">
                No active discount codes found. Go to{" "}
                <s-text fontWeight="bold">Shopify Admin → Discounts → Create discount</s-text>{" "}
                and choose method <s-text fontWeight="bold">"Discount code"</s-text> (not "Automatic").
                Only code-based discounts can be auto-applied via UTM links.
              </s-banner>
            ) : (
              <s-stack direction="block" gap="tight">
                {discounts.map((d) => (
                  <s-box
                    key={d.code}
                    padding="base"
                    borderWidth="base"
                    borderRadius="base"
                    background={selectedDiscount?.code === d.code ? "surface-brand" : "surface"}
                    onClick={() => setSelectedDiscount(d)}
                    style={{ cursor: "pointer" }}
                  >
                    <s-stack direction="inline" gap="base" align="center">
                      <s-stack direction="block" gap="tight" style={{ flex: 1 }}>
                        <s-text fontWeight="bold">{d.title}</s-text>
                        <s-text variant="subdued">
                          Code: {d.code} — {d.summary}
                        </s-text>
                      </s-stack>
                      {selectedDiscount?.code === d.code && (
                        <s-badge tone="success">Selected</s-badge>
                      )}
                    </s-stack>
                  </s-box>
                ))}
              </s-stack>
            )}

            <s-button
              variant="primary"
              onClick={handleCreate}
              {...(isSubmitting ? { loading: true } : {})}
            >
              Save Rule
            </s-button>
          </s-stack>
        </s-section>
      )}

      <s-section heading={`Active Rules (${rules.length})`}>
        {rules.length === 0 ? (
          <s-empty-state heading="No rules yet">
            <s-paragraph>
              Map a UTM source to a Shopify discount code. When visitors arrive
              with that UTM, the discount is automatically applied.
            </s-paragraph>
          </s-empty-state>
        ) : (
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
                      {rule.discountTitle || rule.discountCode}
                    </s-text>
                    <s-text variant="subdued">
                      utm_source=<s-text fontWeight="bold">{rule.utmSource}</s-text>
                      {" → "}auto-apply code: <s-text fontWeight="bold">{rule.discountCode}</s-text>
                    </s-text>
                    <s-badge tone={rule.isActive ? "success" : "default"}>
                      {rule.isActive ? "Active" : "Inactive"}
                    </s-badge>
                  </s-stack>
                  <s-stack direction="inline" gap="tight">
                    <s-button variant="tertiary" onClick={() => handleToggle(rule)}>
                      {rule.isActive ? "Deactivate" : "Activate"}
                    </s-button>
                    <s-button
                      variant="tertiary"
                      tone="critical"
                      onClick={() => handleDelete(rule)}
                    >
                      Delete
                    </s-button>
                  </s-stack>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="How it works">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <s-text fontWeight="bold">1. Create discounts</s-text> — Create discount
            codes in Shopify Admin → Discounts (set products, amount, conditions).
          </s-paragraph>
          <s-paragraph>
            <s-text fontWeight="bold">2. Map UTM → Discount</s-text> — Use this page
            to link a utm_source value to a Shopify discount code.
          </s-paragraph>
          <s-paragraph>
            <s-text fontWeight="bold">3. Add theme snippet</s-text> — Paste the Liquid
            snippet into your theme. It reads the rules and auto-applies the
            discount when a visitor arrives with a matching UTM.
          </s-paragraph>
          <s-paragraph>
            <s-text fontWeight="bold">4. Seamless checkout</s-text> — The native
            Shopify discount is applied automatically. No flicker, no hacks.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Theme snippet">
        <s-paragraph>
          Add this to your theme's <s-text fontWeight="bold">layout/theme.liquid</s-text> file,
          before the closing {"</body>"} tag. Replace the old snippet if you had one.
        </s-paragraph>
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <pre style={{ margin: 0, fontSize: "12px", whiteSpace: "pre-wrap" }}>
            <code>{themeSnippet}</code>
          </pre>
        </s-box>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
