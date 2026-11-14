// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeApi, renderApp, reply, route, status, tick } from "../test-utils.tsx";
import { NoticeBanner, NoticeBanners, noticeRange, noticeUntil, safeHref } from "./Notice.tsx";

// The times are drawn in the reader's own zone: the tests read them in one they choose.
const zone = process.env.TZ;
beforeAll(() => { process.env.TZ = "Europe/Berlin"; });
afterAll(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const TEXT = "Upgrading the DevNet validator database. Ostia pauses for about 45 minutes.";
const NOTICE = { text: TEXT, startsAt: "2026-11-14T09:00:00.000Z", endsAt: "2026-11-14T10:00:00.000Z" };
const at = (iso: string) => vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: Date.parse(iso) });
const NOON = /(10:00( AM)? – 11:00( AM)?) (GMT\+1|CET)/;

describe("the times", () => {
  it("run in the reader's zone, from start to end, with the day on each side when the work crosses midnight", () => {
    expect(new Date(NOTICE.startsAt).getHours()).toBe(10);
    expect(noticeRange(NOTICE.startsAt, NOTICE.endsAt)).toMatch(/^Nov 14, 10:00( AM)? – 11:00( AM)? (GMT\+1|CET)$/);
    expect(noticeRange("2026-11-14T22:30:00Z", "2026-11-15T00:30:00Z")).toMatch(/^Nov 14, (11:30 PM|23:30) – Nov 15, (01:30 AM|01:30) (GMT\+1|CET)$/);
    expect(noticeUntil(NOTICE.endsAt, Date.parse("2026-11-14T09:10:00Z"))).toMatch(/^until 11:00( AM)? (GMT\+1|CET)$/);
    expect(noticeUntil(NOTICE.endsAt, Date.parse("2026-11-13T09:10:00Z"))).toMatch(/^until Nov 14, 11:00( AM)? (GMT\+1|CET)$/);
  });
});

describe("the notice banner", () => {
  it("reads as planned before the start, with the text and the time range", () => {
    at("2026-11-14T08:00:00Z");
    render(<NoticeBanner notice={NOTICE} />);
    const b = screen.getByRole("status");
    expect(b).toHaveClass("planned");
    expect(b).toHaveTextContent(`Planned maintenance: ${TEXT}`);
    expect(b.textContent).toMatch(NOON);
    expect(b).not.toHaveTextContent("in progress");
  });

  it("reads as in progress between the start and the end, with when it ends", () => {
    at("2026-11-14T09:10:00Z");
    render(<NoticeBanner notice={NOTICE} />);
    const b = screen.getByRole("status");
    expect(b).toHaveClass("now");
    expect(b).toHaveTextContent(`Maintenance in progress: ${TEXT}`);
    expect(b.textContent).toMatch(/until 11:00( AM)? (GMT\+1|CET)/);
    expect(b).not.toHaveTextContent("Planned");
  });

  it("changes from planned to in progress and then goes, by the clock, with no new status", async () => {
    at("2026-11-14T08:59:58Z");
    render(<NoticeBanner notice={NOTICE} />);
    expect(screen.getByRole("status")).toHaveTextContent("Planned maintenance:");
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("status")).toHaveTextContent("Maintenance in progress:");
    await act(async () => { await vi.advanceTimersByTimeAsync(58 * 60_000); });
    expect(screen.getByRole("status")).toHaveTextContent("Maintenance in progress:");
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * 60_000); });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows nothing when there is no notice, when it has ended, or when its times are not times", () => {
    at("2026-11-14T10:00:00Z");
    const { rerender, container } = render(<NoticeBanner notice={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<NoticeBanner notice={undefined} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<NoticeBanner notice={NOTICE} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<NoticeBanner notice={{ ...NOTICE, endsAt: "later" }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("draws the text as text: markup in it is shown as the characters it is, and makes no element", () => {
    at("2026-11-14T08:00:00Z");
    const evil = `<img src=x onerror="alert(1)"> <a href="https://example.org">go</a>`;
    render(<NoticeBanner notice={{ ...NOTICE, text: evil }} />);
    const b = screen.getByRole("status");
    expect(b).toHaveTextContent(evil);
    expect(b.querySelector("img, a")).toBeNull();
  });
});

describe("the banner on the pages", () => {
  const withNotice = (notice: unknown, code = 200) => route({ status: () => ({ status: code, body: { ...status(), ...(notice === "absent" ? {} : { notice }) } }) });

  it.each(["/", "/blocks", "/faucet", "/bridge", "/docs/api", "/nowhere"])("is at the top of %s while the work is planned, above the bar and the header", async (path) => {
    at("2026-11-14T08:00:00Z");
    fakeApi(withNotice(NOTICE));
    const { container } = renderApp(path);
    const b = await screen.findByText(/Planned maintenance:/);
    const first = container.querySelector(".page")!.firstElementChild!;
    expect(first).toHaveClass("notice");
    expect(first).toContainElement(b);
    expect(first.nextElementSibling).toHaveClass("topbar");
    expect(screen.getAllByRole("status").filter((x) => x.classList.contains("notice"))).toHaveLength(1);
  });

  it("is on the Bridge page while the work is in progress, and the page itself is as before", async () => {
    at("2026-11-14T09:15:00Z");
    fakeApi(withNotice(NOTICE));
    renderApp("/bridge");
    expect(await screen.findByText(/Maintenance in progress:/)).toBeInTheDocument();
    expect(await screen.findByText("The bridge is not set up on this site yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Bridge" })).toHaveClass("active");
  });

  it("is on the pages when the explorer answers 503, the case of an outage", async () => {
    at("2026-11-14T09:15:00Z");
    fakeApi(withNotice(NOTICE, 503));
    renderApp("/faucet");
    expect(await screen.findByText(/Maintenance in progress:/)).toBeInTheDocument();
  });

  it.each([["null", null], ["a server from before notices", "absent"]])("is not there with %s", async (_n, notice) => {
    at("2026-11-14T08:00:00Z");
    fakeApi(withNotice(notice));
    renderApp("/bridge");
    await screen.findByText("The bridge is not set up on this site yet.");
    expect(document.querySelector(".notice")).toBeNull();
  });

  it("is gone from the pages once the work has ended", async () => {
    at("2026-11-14T10:00:05Z");
    fakeApi(withNotice(NOTICE));
    renderApp("/faucet");
    await screen.findByRole("link", { name: "Faucet" });
    await waitFor(() => expect(document.querySelector(".topbar")).not.toBeNull());
    expect(document.querySelector(".notice")).toBeNull();
  });

  it("stays on a page that is open while the explorer cannot be reached, and goes when the notice is cleared", async () => {
    at("2026-11-14T08:00:00Z");
    let answer: "notice" | "down" | "cleared" = "notice";
    fakeApi(route({ status: () => (answer === "down" ? { status: 502, body: null } : reply({ ...status(), notice: answer === "notice" ? NOTICE : null })) }));
    renderApp("/faucet");
    expect(await screen.findByText(/Planned maintenance:/)).toBeInTheDocument();
    answer = "down";
    await tick(4000);
    expect(screen.getByText(/Planned maintenance:/)).toBeInTheDocument();
    answer = "cleared";
    await tick(4000);
    await waitFor(() => expect(screen.queryByText(/Planned maintenance:/)).toBeNull());
  });
});

const MAJOR = { text: "This DevNet chain moves to Canton TestNet.", startsAt: "2026-11-13T00:00:00.000Z", endsAt: "2026-12-01T00:00:00.000Z", level: "major" as const, link: { url: "https://explorer.example.org/docs/move", label: "What is changing" } };

describe("a major notice", () => {
  it("is the large banner: it says Important notice, not maintenance, with the text, the times and the link", () => {
    at("2026-11-14T08:00:00Z");
    render(<NoticeBanner notice={MAJOR} />);
    const b = screen.getByRole("status");
    expect(b).toHaveClass("notice", "major", "now");
    expect(b).toHaveTextContent("Important notice: This DevNet chain moves to Canton TestNet.");
    expect(b.textContent).toMatch(/until Dec 1, 01:00( AM)? (GMT\+1|CET)/);
    expect(b).not.toHaveTextContent("maintenance");
    const a = screen.getByRole("link", { name: "What is changing" });
    expect(a).toHaveAttribute("href", "https://explorer.example.org/docs/move");
    expect(a).toHaveAttribute("rel", "noopener noreferrer");
    expect(a).toHaveAttribute("target", "_blank");
    expect(a).toHaveClass("notice-link");
  });

  it("reads as planned before its start, with the range, and goes at its end", () => {
    at("2026-11-12T08:00:00Z");
    const first = render(<NoticeBanner notice={MAJOR} />);
    expect(screen.getByRole("status")).toHaveClass("major", "planned");
    expect(screen.getByRole("status").textContent).toMatch(/Nov 13, 01:00( AM)? – Dec 1, 01:00( AM)? (GMT\+1|CET)/);
    first.unmount();
    at("2026-12-01T00:00:00Z");
    const { container } = render(<NoticeBanner notice={MAJOR} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("changes from planned to in progress by the clock, the large banner all the time", async () => {
    at("2026-11-12T23:59:58Z");
    render(<NoticeBanner notice={MAJOR} />);
    expect(screen.getByRole("status")).toHaveClass("planned");
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("status")).toHaveClass("major", "now");
  });

  it("has no link element without a link, and a slim notice keeps its words with or without one", () => {
    at("2026-11-14T08:00:00Z");
    const { rerender } = render(<NoticeBanner notice={{ ...MAJOR, link: undefined }} />);
    expect(screen.queryByRole("link")).toBeNull();
    rerender(<NoticeBanner notice={{ ...NOTICE, link: { url: "http://example.org/a", label: "More" } }} />);
    const b = screen.getByRole("status");
    expect(b).not.toHaveClass("major");
    expect(b).toHaveTextContent("Planned maintenance:");
    expect(screen.getByRole("link", { name: "More" })).toHaveAttribute("href", "http://example.org/a");
    rerender(<NoticeBanner notice={NOTICE} />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it.each(["javascript:alert(1)", "data:text/html,x", "ftp://example.org/", "/docs/move", "not a url", ""])("makes no anchor from the address %j, and the text is still there", (url) => {
    at("2026-11-14T08:00:00Z");
    render(<NoticeBanner notice={{ ...MAJOR, link: { url, label: "What is changing" } }} />);
    expect(document.querySelector("a")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("moves to Canton TestNet");
  });

  it("draws the text and the label as text: markup in them makes no element", () => {
    at("2026-11-14T08:00:00Z");
    const evil = `<img src=x onerror="alert(1)"><script>alert(1)</script>`;
    render(<NoticeBanner notice={{ ...MAJOR, text: evil, link: { url: "https://example.org/", label: evil } }} />);
    const b = screen.getByRole("status");
    expect(b.querySelector("img, script")).toBeNull();
    expect(b.querySelectorAll("a")).toHaveLength(1);
    expect(b.querySelector("a")).toHaveTextContent(evil);
    expect(b).toHaveTextContent(evil);
  });
});

describe("safeHref", () => {
  it("gives http and https addresses and nothing else", () => {
    expect(safeHref("https://example.org/a?b=1")).toBe("https://example.org/a?b=1");
    expect(safeHref("http://example.org")).toBe("http://example.org/");
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "data:text/html,x", "vbscript:x", "ftp://example.org", "//example.org", "/a", "", "x"]) expect(safeHref(bad), bad).toBeNull();
    expect(safeHref(undefined)).toBeNull();
    expect(safeHref(5 as never)).toBeNull();
  });
});

describe("the banners", () => {
  const SLIM_A = { ...NOTICE, text: "Slim A." }, SLIM_B = { ...NOTICE, text: "Slim B." };

  it("show the major ones above the others, whatever the order they come in, each its own banner", () => {
    at("2026-11-14T09:30:00Z");
    render(<NoticeBanners notices={[SLIM_A, MAJOR, SLIM_B, { ...MAJOR, text: "Second major." }]} />);
    const texts = screen.getAllByRole("status").map((e) => e.textContent ?? "");
    expect(texts).toHaveLength(4);
    expect(texts[0]).toContain("This DevNet chain moves");
    expect(texts[1]).toContain("Second major.");
    expect(texts[2]).toContain("Slim A.");
    expect(texts[3]).toContain("Slim B.");
    expect(screen.getAllByRole("status").map((e) => e.classList.contains("major"))).toEqual([true, true, false, false]);
  });

  it("drop each at its own end, by the clock", async () => {
    at("2026-11-14T09:59:58Z");
    render(<NoticeBanners notices={[SLIM_A, { ...MAJOR, endsAt: "2026-11-14T10:00:30Z" }]} />);
    expect(screen.getAllByRole("status")).toHaveLength(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveClass("major");
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("use the old notice alone when the server has no list, and nothing for neither", () => {
    at("2026-11-14T08:00:00Z");
    const { container, rerender } = render(<NoticeBanners notice={NOTICE} />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    rerender(<NoticeBanners notice={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<NoticeBanners />);
    expect(container).toBeEmptyDOMElement();
    rerender(<NoticeBanners notices={[]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<NoticeBanners notices={[]} notice={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("the banners on the pages", () => {
  const withList = (notices: unknown[]) => route({ status: () => reply({ ...status(), notices, notice: notices[0] ?? null }) });

  it("put the major banner first, above the slim one, the bar and the header, on every page", async () => {
    at("2026-11-14T08:00:00Z");
    for (const path of ["/", "/faucet", "/bridge"]) {
      fakeApi(withList([NOTICE, MAJOR]));
      const { container, unmount } = renderApp(path);
      await screen.findByText(/Important notice:/);
      const page = container.querySelector(".page")!;
      expect(page.children[0]).toHaveClass("notice", "major");
      expect(page.children[1]).toHaveClass("notice");
      expect(page.children[1]).not.toHaveClass("major");
      expect(page.children[2]).toHaveClass("topbar");
      unmount();
    }
  });

  it("show a server's old single notice as before", async () => {
    at("2026-11-14T08:00:00Z");
    fakeApi(route({ status: () => reply({ ...status(), notices: undefined, notice: NOTICE }) }));
    renderApp("/faucet");
    expect(await screen.findByText(/Planned maintenance:/)).toBeInTheDocument();
    expect(document.querySelectorAll(".notice")).toHaveLength(1);
  });
});
