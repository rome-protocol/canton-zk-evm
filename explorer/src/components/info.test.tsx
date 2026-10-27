// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Info } from "./Info.tsx";

describe("the small i", () => {
  it("is a button named for what it is about, with the note read with it", () => {
    render(<Info about="Proof time">Proved with ZisK.</Info>);
    const b = screen.getByRole("button", { name: "About Proof time" });
    expect(b).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Proved with ZisK.");
    expect(b.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
  });

  it("opens on a tap and closes on a second tap, on Escape, and on a tap elsewhere", () => {
    const { container } = render(<><Info about="a card">The note.</Info><p>elsewhere</p></>);
    const b = screen.getByRole("button", { name: "About a card" });
    const box = container.querySelector(".info")!;
    fireEvent.click(b);
    expect(b).toHaveAttribute("aria-expanded", "true");
    expect(box).toHaveClass("open");
    fireEvent.click(b);
    expect(box).not.toHaveClass("open");
    fireEvent.click(b);
    fireEvent.keyDown(b, { key: "Escape" });
    expect(box).not.toHaveClass("open");
    fireEvent.click(b);
    fireEvent.pointerDown(screen.getByText("elsewhere"));
    expect(box).not.toHaveClass("open");
  });
});
