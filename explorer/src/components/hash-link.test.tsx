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

  it("carries the whole value in its title while it is shortened, so a long one can wrap or be cut without losing it", () => {
    render(<MemoryRouter><HashLink value={h} to={`/block/${h}`} /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "0x3535…3535" })).toHaveAttribute("title", h);
  });

  it("is plain text when it has nowhere to link to", () => {
    render(<MemoryRouter><HashLink value={h} /></MemoryRouter>);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("0x3535…3535")).toBeInTheDocument();
  });

  it("shows a Canton update id as its first eight characters and last four", () => {
    render(<MemoryRouter><HashLink value={update(0x19)} kind="update" /></MemoryRouter>);
    expect(screen.getByText("12201919…1919")).toBeInTheDocument();
  });

  it("shows a plain hash in a list without the copy and expand buttons", () => {
    render(<MemoryRouter><HashLink value={h} to={`/tx/${h}`} plain /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "0x35353535…353535" })).toHaveAttribute("href", `/tx/${h}`);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("takes the length the screen shows: a plain hash 0x and eight, then six; a compact list 0x and six, then four", () => {
    const { unmount } = render(<MemoryRouter><HashLink value={h} plain lead={8} tail={4} /></MemoryRouter>);
    expect(screen.getByText("0x353535…3535")).toBeInTheDocument();
    unmount();
    render(<MemoryRouter><HashLink value={h} lead={12} tail={6} /></MemoryRouter>);
    expect(screen.getByText("0x3535353535…353535")).toBeInTheDocument();
  });

  it("shortens a Canton update id to the lengths a page asks for, and to twelve and eight when long", () => {
    const id = update(0x19);
    const { unmount } = render(<MemoryRouter><HashLink value={id} kind="update" lead={10} tail={6} /></MemoryRouter>);
    expect(screen.getByText("1220191919…191919")).toBeInTheDocument();
    unmount();
    render(<MemoryRouter><HashLink value={id} kind="update" long /></MemoryRouter>);
    expect(screen.getByText("122019191919…19191919")).toBeInTheDocument();
  });

  it("keeps the copy and expand buttons by default, for a detail page", () => {
    render(<MemoryRouter><HashLink value={h} /></MemoryRouter>);
    expect(screen.getAllByRole("button")).toHaveLength(2);
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
  it.each([["final", "Final"], ["proving", "Being proven"], ["unindexed", "Not indexed yet"], ["waiting", "Waiting"], ["genesis", "Genesis"]] as const)("%s reads %s", (kind, word) => {
    render(<Chip status={kind} />);
    expect(screen.getByText(word)).toHaveClass(`chip-${kind}`);
  });
});
