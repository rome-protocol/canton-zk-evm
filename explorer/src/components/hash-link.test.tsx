// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { HashLink } from "./HashLink.tsx";
import { Chip } from "./Chip.tsx";
import { hash, update } from "../test-utils.tsx";

const h = hash(0x35);

describe("a hash", () => {
  it("shows six characters and four, and links where it is told to", () => {
    render(<MemoryRouter><HashLink value={h} to={`/block/${h}`} /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "0x3535…3535" })).toHaveAttribute("href", `/block/${h}`);
  });

  it("is plain text when it has nowhere to link to", () => {
    render(<MemoryRouter><HashLink value={h} /></MemoryRouter>);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("0x3535…3535")).toBeInTheDocument();
  });

  it("shows a Canton update id as its four-digit prefix, then eight characters", () => {
    render(<MemoryRouter><HashLink value={update(0x19)} kind="update" /></MemoryRouter>);
    expect(screen.getByText("1220 1919…1919")).toBeInTheDocument();
  });

  it("shows a Canton party id as its name and the ends of its identifier", () => {
    render(<MemoryRouter><HashLink value={"operator::1220" + "ab".repeat(30) + "3619"} kind="party" /></MemoryRouter>);
    expect(screen.getByText("operator::1220…3619")).toBeInTheDocument();
  });

  it("shows ten characters and eight for the hash a page is about", () => {
    render(<MemoryRouter><HashLink value={h} long /></MemoryRouter>);
    expect(screen.getByText("0x35353535…35353535")).toBeInTheDocument();
  });

  it("copies the whole value, and says so", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<MemoryRouter><HashLink value={h} /></MemoryRouter>);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(h);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("shows the whole value on request, and goes back", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><HashLink value={h} /></MemoryRouter>);
    await user.click(screen.getByRole("button", { name: "Show in full" }));
    expect(screen.getByText(h)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show shortened" }));
    expect(screen.getByText("0x3535…3535")).toBeInTheDocument();
  });

  it("starts in full for a page's own hash", () => {
    render(<MemoryRouter><HashLink value={h} full /></MemoryRouter>);
    expect(screen.getByText(h)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show in full" })).toBeNull();
  });
});

describe("the status words", () => {
  it.each([["final", "Final"], ["proving", "Being proven"], ["waiting", "Waiting"], ["genesis", "Genesis"]] as const)("%s reads %s", (kind, word) => {
    render(<Chip status={kind} />);
    expect(screen.getByText(word)).toHaveClass(`chip-${kind}`);
  });
});
