import { test, expect } from "../../test-isolation-helper";
import { A2UIPage } from "../../featurePages/A2UIPage";

// A DOM-only test of the A2UIPage surface helpers: it drives static markup via
// page.setContent, so it needs no dojo server, no agent and no mock LLM.
//
// It exists because the A2UI action specs assert button COUNTS ("exactly one
// Booked"), and a surface can legitimately be painted twice for the same surface
// id: an action run repaints it, and a stale hidden node can linger in the DOM.
// A count taken across every node with that id then doubles, so the assertion
// reports the duplicate paint as a wrong number of clicks. The helpers under test
// scope the count to a single visible surface.

const SURFACE_ID = "hotel-search-results";

/** A surface node with three hotel cards, the second one already booked. */
const surfaceMarkup = (hidden = false) => `
  <div data-surface-id="${SURFACE_ID}"${hidden ? ' style="display:none"' : ""}>
    <div><span>The Manhattan Grand</span><button>Book</button></div>
    <div><span>Downtown Boutique Hotel</span><button>Booked</button></div>
    <div><span>Midtown Suites</span><button>Book</button></div>
  </div>
`;

test("[CrewAI] A2UIPage counts actions on ONE surface when the same id is painted twice", async ({
  page,
}) => {
  await page.setContent(surfaceMarkup() + surfaceMarkup());

  const a2ui = new A2UIPage(page);

  // The hazard: `surface()` stays multi-element on purpose (callers count
  // surfaces with it), so a count through it doubles on a repaint.
  await expect(
    a2ui
      .surface(SURFACE_ID)
      .getByRole("button", { name: "Booked", exact: true }),
  ).toHaveCount(2);

  // The helpers the specs use are unaffected by the duplicate node.
  await expect(a2ui.surfaceActions("Booked", SURFACE_ID)).toHaveCount(1);
  await expect(a2ui.surfaceActions("Book", SURFACE_ID)).toHaveCount(2);
  await expect(
    a2ui
      .visibleSurface(SURFACE_ID)
      .getByRole("button", { name: "Booked", exact: true }),
  ).toHaveCount(1);
});

test("[CrewAI] A2UIPage counts actions on the VISIBLE surface, not a stale hidden one", async ({
  page,
}) => {
  // The stale node comes first in the DOM, so a `.first()` that ignored
  // visibility would count inside the surface the user cannot see.
  await page.setContent(surfaceMarkup(true) + surfaceMarkup());

  const a2ui = new A2UIPage(page);

  await expect(a2ui.surfaceActions("Booked", SURFACE_ID)).toHaveCount(1);
  await expect(a2ui.surfaceActions("Booked", SURFACE_ID)).toBeVisible();
});
