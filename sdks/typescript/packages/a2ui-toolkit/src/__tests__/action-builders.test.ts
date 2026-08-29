import { describe, it, expect } from "vitest";
import { setValue, toggleValue } from "../index";

describe("setValue action builder", () => {
  it("builds an agui.setValue functionCall action with path and value", () => {
    expect(setValue("/showDetails", true)).toEqual({
      functionCall: { call: "agui.setValue", args: { path: "/showDetails", value: true } },
    });
  });
});

describe("toggleValue action builder", () => {
  it("builds an agui.toggleValue functionCall action with just a path", () => {
    expect(toggleValue("/showDetails")).toEqual({
      functionCall: { call: "agui.toggleValue", args: { path: "/showDetails" } },
    });
  });

  it("includes value for an empty↔value (List show/hide) toggle", () => {
    expect(toggleValue("/details", [{ id: 1 }])).toEqual({
      functionCall: { call: "agui.toggleValue", args: { path: "/details", value: [{ id: 1 }] } },
    });
  });
});
