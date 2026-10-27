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
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box).not.toHaveClass("open");
    fireEvent.mouseLeave(box);
    fireEvent.mouseEnter(box);
    expect(box).toHaveClass("open");
    fireEvent.mouseLeave(box);
    expect(box).not.toHaveClass("open");
  });

  it("moves the note sideways to keep it inside the screen", () => {
    const rect = (left: number, right: number) => ({ left, right, top: 0, bottom: 0, width: right - left, height: 0, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
    const { container } = render(<Info about="a card">The note.</Info>);
    const note = container.querySelector<HTMLElement>(".info-t")!;
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 390 });
    const fit = (left: number, right: number) => { note.getBoundingClientRect = () => rect(left, right); fireEvent.mouseLeave(container.querySelector(".info")!); fireEvent.mouseEnter(container.querySelector(".info")!); return note.style.transform; };
    expect(fit(-100, 160)).toBe("translateX(108px)");
    expect(fit(150, 410)).toBe("translateX(-28px)");
    expect(fit(40, 300)).toBe("");
  });
});
