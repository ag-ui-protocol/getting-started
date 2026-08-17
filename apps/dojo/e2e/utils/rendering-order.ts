import { expect, type Locator } from "@playwright/test";

/**
 * Assert that `later` is rendered after `earlier`: it follows `earlier` in the
 * DOM, both have a layout box, and its box starts lower on screen.
 *
 * The y comparison is only meaningful for elements the caller already knows
 * stack in one column, so scope the locators accordingly (for example to a
 * single message) before calling this.
 */
export async function expectRenderedAfter(
  earlier: Locator,
  later: Locator,
): Promise<void> {
  await expect(earlier).toBeAttached();
  await expect(later).toBeAttached();

  const laterHandle = await later.elementHandle();
  try {
    const followsInDocument = await earlier.evaluate(
      (earlierElement, laterElement) =>
        Boolean(
          earlierElement.compareDocumentPosition(laterElement as Node) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      laterHandle,
    );
    expect(
      followsInDocument,
      "later element must follow the earlier element in the DOM",
    ).toBe(true);
  } finally {
    // Swallow dispose rejections: at teardown the target may already be
    // closed, and that must not replace the assertion failure above.
    await laterHandle?.dispose().catch(() => {});
  }

  const [earlierBox, laterBox] = await Promise.all([
    earlier.boundingBox(),
    later.boundingBox(),
  ]);
  expect(earlierBox, "earlier element must have a layout box").not.toBeNull();
  expect(laterBox, "later element must have a layout box").not.toBeNull();

  expect(
    earlierBox!.y,
    "earlier element must start above the later element",
  ).toBeLessThan(laterBox!.y);
}
