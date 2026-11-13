// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeApi, renderApp, reply, route, status, tick } from "../test-utils.tsx";
import { NoticeBanner, noticeRange, noticeUntil } from "./Notice.tsx";

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
