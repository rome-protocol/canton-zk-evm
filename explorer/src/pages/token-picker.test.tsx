// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pairsOf } from "../bridge/tokens.ts";
import { config, GATEWAY_PARTY } from "./bridge-fakes.ts";
import { TokenPicker } from "./TokenPicker.tsx";

afterEach(cleanup);
const pairs = pairsOf(config, GATEWAY_PARTY);
const picker = (onClose: () => void) => <TokenPicker pairs={pairs} chainName="Ostia" selected={null} onPick={() => {}} onClose={onClose} />;

describe("the token picker", () => {
  it("focuses the search box once, and a card that draws again with a new onClose does not pull the focus back", () => {
    const { rerender } = render(picker(() => {}));
    const box = screen.getByRole("searchbox", { name: "Search tokens" });
    expect(box).toHaveFocus();
    screen.getByRole("button", { name: "Close" }).focus();
    for (let i = 0; i < 3; i++) rerender(picker(() => {}));   // the card's balance tick draws it again
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });
  it("closes on Escape with the newest onClose", async () => {
    const first = vi.fn(), second = vi.fn();
    const { rerender } = render(picker(first));
    rerender(picker(second));
    await userEvent.keyboard("{Escape}");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
