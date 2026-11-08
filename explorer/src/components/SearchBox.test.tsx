// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchBox } from "./SearchBox.tsx";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** A screen that matches the phone query or not. */
const screenOf = (phone: boolean) => vi.stubGlobal("matchMedia", (q: string) => ({ matches: phone, media: q, addEventListener() {}, removeEventListener() {} }));
const hint = (hero = false) => { render(<MemoryRouter><SearchBox hero={hero} /></MemoryRouter>); return screen.getByRole("searchbox").getAttribute("placeholder")!; };

describe("the search box's hint", () => {
  it("is short enough for the header at phone width (35 characters, 328 px holds about 42)", () => {
    screenOf(true);
    const h = hint();
    expect(h).toBe("Block, tx, address or Canton update");
    expect(h.length).toBeLessThanOrEqual(38);
  });
  it("says the whole thing in the header above phone width, and the home page's own on the hero", () => {
    screenOf(false);
    expect(hint()).toBe("Block, transaction, address or Canton update id");
    cleanup();
    expect(hint(true)).toMatch(/^Search by block number/);
  });
});
