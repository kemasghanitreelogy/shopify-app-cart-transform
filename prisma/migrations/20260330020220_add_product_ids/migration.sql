-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DiscountRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "utmSource" TEXT NOT NULL,
    "discountType" TEXT NOT NULL DEFAULT 'percentage',
    "discountValue" REAL NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "title" TEXT NOT NULL DEFAULT '',
    "productIds" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_DiscountRule" ("createdAt", "discountType", "discountValue", "id", "isActive", "shop", "title", "updatedAt", "utmSource") SELECT "createdAt", "discountType", "discountValue", "id", "isActive", "shop", "title", "updatedAt", "utmSource" FROM "DiscountRule";
DROP TABLE "DiscountRule";
ALTER TABLE "new_DiscountRule" RENAME TO "DiscountRule";
CREATE INDEX "DiscountRule_shop_idx" ON "DiscountRule"("shop");
CREATE UNIQUE INDEX "DiscountRule_shop_utmSource_key" ON "DiscountRule"("shop", "utmSource");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
