// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Info } from "./Info.tsx";

describe("the small i", () => {
  afterEach(cleanup);

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

  it("closes on a second tap and on Escape although the button still has the focus", () => {
    const { container } = render(<Info about="a card">The note.</Info>);
    const b = screen.getByRole("button", { name: "About a card" });
    const box = container.querySelector(".info")!;
    // a touch tap: the button takes the focus, then the click comes
    fireEvent.focus(b);
    expect(box).toHaveClass("open");
    fireEvent.click(b);
    expect(box).toHaveClass("open");
    fireEvent.click(b);
    expect(box).not.toHaveClass("open");
    expect(b).toHaveAttribute("aria-expanded", "false");
    // the keyboard: focus shows the note, Escape hides it, and it stays hidden until the focus leaves and comes back
    fireEvent.blur(b);
    fireEvent.focus(b);
    expect(box).toHaveClass("open");
    fireEvent.keyDown(b, { key: "Escape" });
    expect(box).not.toHaveClass("open");
    fireEvent.blur(b);
    fireEvent.focus(b);
    expect(box).toHaveClass("open");
  });

  it("shows on hover and stays hidden after Escape until the pointer has left", () => {
    const { container } = render(<Info about="a card">The note.</Info>);
    const box = container.querySelector(".info")!;
    fireEvent.mouseEnter(box);
    expect(box).toHaveClass("open");
    // a hover alone puts the focus nowhere near the i, so the Escape arrives at the page
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(box).not.toHaveClass("open");
    fireEvent.mouseLeave(box);
    fireEvent.mouseEnter(box);
    expect(box).toHaveClass("open");
    fireEvent.mouseLeave(box);
    expect(box).not.toHaveClass("open");
  });

  it("places the note below the i, moved sideways to sit inside the screen, and above it when there is no room below", () => {
    const rect = (l: number, t: number, w: number, h: number) => ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h, x: l, y: t, toJSON: () => ({}) }) as DOMRect;
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 390 });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 800 });
    const { container } = render(<Info about="a card">The note.</Info>);
    const note = screen.getByRole("tooltip");
    const btn = screen.getByRole("button", { name: "About a card" });
    const box = container.querySelector(".info")!;
    note.getBoundingClientRect = () => rect(0, 0, 260, 60);
    const at = (l: number, t: number) => {
      btn.getBoundingClientRect = () => rect(l, t, 18, 18);
      fireEvent.mouseLeave(box); fireEvent.mouseEnter(box);
      return [note.style.left, note.style.top];
    };
    expect(at(300, 100)).toEqual(["66px", "126px"]); // right edge of the note 8 px past the i's, 8 px below
    expect(at(10, 100)).toEqual(["8px", "126px"]); // pushed in from the left edge
    expect(at(370, 100)).toEqual(["122px", "126px"]); // pushed in from the right edge
    expect(at(200, 760)).toEqual(["8px", "692px"]); // no room below: above the i
  });
});
