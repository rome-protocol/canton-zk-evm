// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { CardHead, DownloadLink } from "./Cards.tsx";
import { Icon, ICON_NAMES } from "./Icon.tsx";

describe("the icon set", () => {
  it("has the icons the approved screens use: the stat-card labels, the doc, the cube, the download, the menu and the filter funnel", () => {
    for (const n of ["cube", "clock", "shield", "link", "bolt", "doc", "download", "menu", "activity", "funnel"]) expect(ICON_NAMES, n).toContain(n);
  });

  it("draws every icon as a decorative svg with something in it", () => {
    for (const n of ICON_NAMES) {
      const { container, unmount } = render(<Icon name={n} />);
      const svg = container.querySelector("svg")!;
      expect(svg.getAttribute("aria-hidden"), n).toBe("true");
      expect(svg.children.length, n).toBeGreaterThan(0);
      unmount();
    }
  });
});

describe("the card header", () => {
  it("sets a bold title and a grey subtitle in line with it, and an action at the end", () => {
    render(<CardHead title="The proof" sub="of block 20" action={<span>Act</span>} />);
    const head = screen.getByRole("heading", { name: "The proof" });
    expect(head.tagName).toBe("H3");
    expect(screen.getByText("of block 20")).toHaveClass("muted", "small");
    expect(head.parentElement).toContainElement(screen.getByText("of block 20"));
    expect(screen.getByText("Act")).toBeInTheDocument();
  });

  it("leaves the subtitle out when there is none, and takes a heading level", () => {
    render(<CardHead title="Only" as="h2" />);
    expect(screen.getByRole("heading", { level: 2, name: "Only" }).parentElement!.children).toHaveLength(1);
  });
});

describe("the download button", () => {
  it("is a link that downloads, with the download icon before its label", () => {
    render(<MemoryRouter><DownloadLink href="/api/blocks.csv" file="blocks.csv">CSV</DownloadLink></MemoryRouter>);
    const a = screen.getByRole("link", { name: "CSV" });
    expect(a).toHaveAttribute("href", "/api/blocks.csv");
    expect(a).toHaveAttribute("download", "blocks.csv");
    expect(a).toHaveClass("csv");
    expect(a.firstElementChild!.tagName.toLowerCase()).toBe("svg");
  });

  it("is a plain link to the data when no file name is given (the browser shows it)", () => {
    render(<DownloadLink href="/api/stats/summary?window=7d">Data</DownloadLink>);
    expect(screen.getByRole("link", { name: "Data" })).not.toHaveAttribute("download");
  });
});
