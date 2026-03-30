import { useEffect, useState, useCallback, useRef } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Get or create the cart transform instance
async function getOrCreateCartTransform(admin) {
  // Check for existing cart transforms
  const cartTransformResponse = await admin.graphql(
    `#graphql
      query {
        cartTransforms(first: 10) {
          nodes {
            id
            functionId
            metafield(namespace: "cart-transform", key: "discount-rules") {
              value
            }
          }
        }
      }`
  );

  const cartTransformData = await cartTransformResponse.json();
  const existing = cartTransformData.data?.cartTransforms?.nodes?.[0];

  if (existing) {
    return existing;
  }

  // No cart transform exists — find our function ID and create one
  const appResponse = await admin.graphql(
    `#graphql
      query {
        shopifyFunctions(first: 25) {
          nodes {
            id
            title
            apiType
            app {
              title
            }
          }
        }
      }`
  );

  const appData = await appResponse.json();
  const cartTransformFunction = appData.data?.shopifyFunctions?.nodes?.find(
    (fn) => fn.apiType === "cart_transform"
  );

  if (!cartTransformFunction) {
    return { error: "Cart transform function not found. Make sure the extension is deployed." };
  }

  // Create the cart transform
  const createResponse = await admin.graphql(
    `#graphql
      mutation CartTransformCreate($functionId: String!) {
        cartTransformCreate(functionId: $functionId) {
          cartTransform {
            id
            functionId
          }
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        functionId: cartTransformFunction.id,
      },
    }
  );

  const createData = await createResponse.json();
  const created = createData.data?.cartTransformCreate?.cartTransform;

  if (!created) {
    const errors = createData.data?.cartTransformCreate?.userErrors;
    return { error: errors?.map((e) => e.message).join(", ") || "Failed to create cart transform." };
  }

  return created;
}

// Sync discount rules to the cart transform metafield
async function syncRulesToMetafield(admin, shop) {
  const rules = await prisma.discountRule.findMany({
    where: { shop },
    select: {
      utmSource: true,
      discountType: true,
      discountValue: true,
      isActive: true,
      title: true,
      productIds: true,
    },
  });

  // Parse productIds from JSON string for the metafield
  const rulesForMetafield = rules.map((rule) => ({
    ...rule,
    productIds: JSON.parse(rule.productIds || "[]"),
  }));

  const cartTransform = await getOrCreateCartTransform(admin);

  if (cartTransform.error) {
    return cartTransform;
  }

  const metafieldResponse = await admin.graphql(
    `#graphql
      mutation UpdateCartTransformMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            namespace
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        metafields: [
          {
            ownerId: cartTransform.id,
            namespace: "cart-transform",
            key: "discount-rules",
            type: "json",
            value: JSON.stringify(rulesForMetafield),
          },
        ],
      },
    }
  );

  const metafieldData = await metafieldResponse.json();
  return metafieldData;
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const rules = await prisma.discountRule.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
  });

  // Collect all product IDs to fetch their titles
  const allProductIds = [];
  for (const rule of rules) {
    const ids = JSON.parse(rule.productIds || "[]");
    for (const id of ids) {
      if (!allProductIds.includes(id)) {
        allProductIds.push(id);
      }
    }
  }

  // Fetch product titles for display
  let productMap = {};
  if (allProductIds.length > 0) {
    const productResponse = await admin.graphql(
      `#graphql
        query GetProducts($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              title
            }
          }
        }`,
      { variables: { ids: allProductIds } }
    );
    const productData = await productResponse.json();
    for (const node of productData.data?.nodes || []) {
      if (node?.id && node?.title) {
        productMap[node.id] = node.title;
      }
    }
  }

  // Check cart transform status
  const cartTransform = await getOrCreateCartTransform(admin);
  const cartTransformStatus = cartTransform.error
    ? { active: false, error: cartTransform.error }
    : { active: true, id: cartTransform.id };

  return { rules, shop, productMap, cartTransformStatus };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  try {
    if (intent === "create") {
      const utmSource = formData.get("utmSource")?.toString().trim();
      const discountType = formData.get("discountType")?.toString() || "percentage";
      const discountValue = parseFloat(formData.get("discountValue")?.toString() || "0");
      const title = formData.get("title")?.toString().trim() || "";
      const productIds = formData.get("productIds")?.toString() || "[]";

      if (!utmSource || discountValue <= 0) {
        return { error: "UTM Source and a positive discount value are required." };
      }

      if (discountType === "percentage" && discountValue > 100) {
        return { error: "Percentage discount cannot exceed 100%." };
      }

      await prisma.discountRule.upsert({
        where: { shop_utmSource: { shop, utmSource } },
        update: { discountType, discountValue, title, productIds, isActive: true },
        create: { shop, utmSource, discountType, discountValue, title, productIds },
      });

      await syncRulesToMetafield(admin, shop);
      return { success: true, message: "Rule created successfully." };
    }

    if (intent === "toggle") {
      const id = formData.get("id")?.toString();
      const isActive = formData.get("isActive") === "true";

      await prisma.discountRule.update({
        where: { id },
        data: { isActive },
      });

      await syncRulesToMetafield(admin, shop);
      return { success: true, message: `Rule ${isActive ? "activated" : "deactivated"}.` };
    }

    if (intent === "delete") {
      const id = formData.get("id")?.toString();

      await prisma.discountRule.delete({ where: { id } });

      await syncRulesToMetafield(admin, shop);
      return { success: true, message: "Rule deleted." };
    }

    if (intent === "sync") {
      const result = await syncRulesToMetafield(admin, shop);
      if (result?.error) {
        return { error: result.error };
      }
      return { success: true, message: "Rules synced to Shopify." };
    }

    return { error: "Unknown action." };
  } catch (error) {
    console.error("Discount rule action error:", error);
    return { error: error.message || "Something went wrong." };
  }
};

export default function DiscountRules() {
  const { rules, productMap, cartTransformStatus } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [showForm, setShowForm] = useState(false);
  const [utmSource, setUtmSource] = useState("");
  const [discountType, setDiscountType] = useState("percentage");
  const [discountValue, setDiscountValue] = useState("");
  const [title, setTitle] = useState("");
  const [selectedProducts, setSelectedProducts] = useState([]);

  const selectRef = useRef(null);

  const isSubmitting = fetcher.state !== "idle";

  // Attach native change listener for s-select
  useEffect(() => {
    const el = selectRef.current;
    if (!el) return;
    const handler = (e) => setDiscountType(e.target.value);
    el.addEventListener("change", handler);
    return () => el.removeEventListener("change", handler);
  }, [showForm]);

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show(fetcher.data.message);
      setShowForm(false);
      setUtmSource("");
      setDiscountType("percentage");
      setDiscountValue("");
      setTitle("");
      setSelectedProducts([]);
    }
    if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const handleSelectProducts = useCallback(async () => {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      selectionIds: selectedProducts.map((p) => ({ id: p.id })),
    });

    if (selected) {
      setSelectedProducts(
        selected.map((p) => ({ id: p.id, title: p.title }))
      );
    }
  }, [shopify, selectedProducts]);

  const handleRemoveProduct = (productId) => {
    setSelectedProducts((prev) => prev.filter((p) => p.id !== productId));
  };

  const handleCreate = () => {
    const productIds = JSON.stringify(selectedProducts.map((p) => p.id));
    fetcher.submit(
      { intent: "create", utmSource, discountType, discountValue, title, productIds },
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
    fetcher.submit(
      { intent: "delete", id: rule.id },
      { method: "POST" }
    );
  };

  const handleSync = () => {
    fetcher.submit({ intent: "sync" }, { method: "POST" });
  };

  const getProductNames = (rule) => {
    const ids = JSON.parse(rule.productIds || "[]");
    if (ids.length === 0) return "All products";
    return ids.map((id) => productMap[id] || id.split("/").pop()).join(", ");
  };

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
        Sync to Shopify
      </s-button>

      {cartTransformStatus?.active ? (
        <s-banner tone="success" dismissible>
          Cart Transform is active and ready to apply discounts.
        </s-banner>
      ) : (
        <s-banner tone="critical">
          Cart Transform is not active: {cartTransformStatus?.error || "Unknown error"}.
          Click "Sync to Shopify" to set it up.
        </s-banner>
      )}

      {showForm && (
        <s-section heading="New Discount Rule">
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Rule Title"
              value={title}
              onInput={(e) => setTitle(e.target.value)}
              placeholder="e.g. Instagram Promo 10%"
            />
            <s-text-field
              label="UTM Source"
              value={utmSource}
              onInput={(e) => setUtmSource(e.target.value)}
              placeholder="e.g. instagram, tiktok, facebook"
            />
            <s-stack direction="inline" gap="base">
              <div style={{ flex: 1 }}>
                <s-select
                  ref={selectRef}
                  label="Discount Type"
                  value={discountType}
                  options={JSON.stringify([
                    { label: "Percentage (%)", value: "percentage" },
                    { label: "Fixed Amount", value: "fixed" },
                  ])}
                />
              </div>
              <div style={{ flex: 1 }}>
                <s-text-field
                  label={discountType === "percentage" ? "Discount (%)" : "Discount Amount"}
                  type="number"
                  value={discountValue}
                  onInput={(e) => setDiscountValue(e.target.value)}
                  placeholder={discountType === "percentage" ? "e.g. 10" : "e.g. 5.00"}
                />
              </div>
            </s-stack>

            <s-stack direction="block" gap="tight">
              <s-text fontWeight="bold">Target Products</s-text>
              <s-paragraph>
                <s-text variant="subdued">
                  Select specific products, or leave empty to apply to all products.
                </s-text>
              </s-paragraph>
              <s-button variant="secondary" onClick={handleSelectProducts}>
                {selectedProducts.length > 0
                  ? `${selectedProducts.length} product(s) selected — Change`
                  : "Select Products"}
              </s-button>
              {selectedProducts.length > 0 && (
                <s-stack direction="block" gap="tight">
                  {selectedProducts.map((product) => (
                    <s-box
                      key={product.id}
                      padding="tight"
                      borderWidth="base"
                      borderRadius="base"
                    >
                      <s-stack direction="inline" gap="tight" align="center">
                        <s-text style={{ flex: 1 }}>{product.title}</s-text>
                        <s-button
                          variant="tertiary"
                          tone="critical"
                          size="slim"
                          onClick={() => handleRemoveProduct(product.id)}
                        >
                          Remove
                        </s-button>
                      </s-stack>
                    </s-box>
                  ))}
                </s-stack>
              )}
            </s-stack>

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
          <s-empty-state heading="No discount rules yet">
            <s-paragraph>
              Create your first UTM-based discount rule to start offering
              targeted pricing to visitors from different traffic sources.
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
                      {rule.title || rule.utmSource}
                    </s-text>
                    <s-text variant="subdued">
                      utm_source={rule.utmSource} →{" "}
                      {rule.discountType === "percentage"
                        ? `${rule.discountValue}% off`
                        : `$${rule.discountValue} off`}
                    </s-text>
                    <s-text variant="subdued">
                      Products: {getProductNames(rule)}
                    </s-text>
                    <s-badge tone={rule.isActive ? "success" : "default"}>
                      {rule.isActive ? "Active" : "Inactive"}
                    </s-badge>
                  </s-stack>
                  <s-stack direction="inline" gap="tight">
                    <s-button
                      variant="tertiary"
                      onClick={() => handleToggle(rule)}
                    >
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
            <s-text fontWeight="bold">1. Create rules</s-text> — Define which
            UTM sources get discounts, how much, and for which products.
          </s-paragraph>
          <s-paragraph>
            <s-text fontWeight="bold">2. Capture UTM</s-text> — Add a snippet
            to your theme that saves utm_source as a cart attribute.
          </s-paragraph>
          <s-paragraph>
            <s-text fontWeight="bold">3. Automatic pricing</s-text> — The Cart
            Transform function applies discounts at checkout, no flicker.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Theme snippet">
        <s-paragraph>
          Add this JavaScript to your theme's layout file to capture the UTM
          source into cart attributes:
        </s-paragraph>
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
          background="subdued"
        >
          <pre style={{ margin: 0, fontSize: "12px", whiteSpace: "pre-wrap" }}>
            <code>{`<script>
(function() {
  const params = new URLSearchParams(window.location.search);
  const utm = params.get('utm_source');
  if (utm) {
    sessionStorage.setItem('utm_source', utm);
  }
  const saved = sessionStorage.getItem('utm_source');
  if (saved) {
    fetch('/cart/update.js', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        attributes: { utm_source: saved }
      })
    });
  }
})();
</script>`}</code>
          </pre>
        </s-box>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
