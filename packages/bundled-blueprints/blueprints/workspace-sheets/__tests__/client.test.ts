import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GadgetStub, SheetChart, SheetFilter, SheetMeta, SheetsDocument, SubscriberCallbacks } from "../files/lib/protocol.ts";

// oxlint-disable-next-line typescript/no-extraneous-class -- the host's RpcTarget is a marker base class.
class RpcTarget {}

const sheet = (id: string): SheetMeta => ({
  id, name: id, rows: 8, cols: 8, colWidths: {}, rowHeights: {}, frozenRows: 0, frozenCols: 0,
  filter: null, charts: [], comments: [], pivot: null,
});
const chart = (title: string, x: number, y: number): SheetChart => ({
  id: "chart", type: "line", range: "A1:B3", title, x, y, width: 520, height: 320,
  xAxisTitle: "", yAxisTitle: "", legend: true, firstRowHeaders: true, firstColLabels: true, smooth: false,
});
const filter = (criteria: SheetFilter["criteria"] = {}): SheetFilter => ({
  row: 0, endRow: 2, columns: [0, 1], criteria, rowOrder: [1, 2], sort: null,
});
const fixture = (): SheetsDocument => ({
  revision: 0, title: "Client regressions", lastModified: 0, sheetOrder: ["sheet", "other"],
  sheets: {
    sheet: { ...sheet("sheet"), charts: [chart("Original", 96, 44)] },
    other: { ...sheet("other"), charts: [chart("Other chart", 300, 120)] },
  },
  cells: {
    sheet: Object.fromEntries(Object.entries({
      A1: "Kind", A2: "drop", A3: "keep", B1: "Sales", B2: "10", B3: "20",
      D1: '=HYPERLINK("https://example.com","Complete")', D2: "=T(D1)",
      D3: "=ISTEXT(D1)", D4: "=ISNONTEXT(D1)", D5: '=IF(TRUE,D1,"no")',
      D6: '=ISTEXT(HYPERLINK("https://example.com",42))',
      D7: '=ISBLANK(HYPERLINK("https://example.com",""))', D8: "=T(42)",
    }).map(([ref, value]) => [ref, { value, fmt: null, version: 1 }])),
    other: {},
  },
});

let subscriber: SubscriberCallbacks;
let initial: SheetsDocument;
const listeners: { target: EventTarget; type: string; listener: EventListenerOrEventListenerObject | null; capture: boolean }[] = [];
let originalStyles: Set<Element>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  initial = fixture();
  originalStyles = new Set(document.head.querySelectorAll("style"));
  // The entry owns page-lifetime listeners; remove those between isolated mounts.
  for (const target of [window, document] as EventTarget[]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation((type, listener, options) => {
      listeners.push({ target, type, listener, capture: typeof options === "boolean" ? options : options?.capture ?? false });
      add(type, listener, options);
    });
  }
  vi.stubGlobal("RpcTarget", RpcTarget);
  // jsdom omits matchMedia; the print listener still receives an actual event target.
  vi.stubGlobal("matchMedia", (media: string) => Object.assign(new EventTarget(), { media, matches: false }));
  // Only text measurement is supplied here; native browser smoke covers actual editor layout.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "", measureText: (text: string) => ({ width: text.length * 8 }),
  } as CanvasRenderingContext2D);
  vi.stubGlobal("gadget", {
    async subscribe(callback) { subscriber = callback; return structuredClone(initial); },
    async updatePresence() {},
    async leavePresence() {},
  } satisfies Pick<GadgetStub, "subscribe" | "updatePresence" | "leavePresence">);
});

afterEach(() => {
  for (const { target, type, listener, capture } of listeners.splice(0)) target.removeEventListener(type, listener, capture);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  for (const style of document.head.querySelectorAll("style")) if (!originalStyles.has(style)) style.remove();
});

const element = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const cell = (ref: string) => element<HTMLTableCellElement>(`td.cell[data-ref="${ref}"]`);
const frame = () => vi.advanceTimersByTimeAsync(16);
// Static import would bootstrap before the host globals exist; each test exercises a fresh page load.
const mount = async () => { await import("../files/client.ts"); await frame(); };
const key = (target: EventTarget, value: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
const select = (ref: string) => {
  const name = element<HTMLInputElement>("input.namebox");
  name.value = ref;
  key(name, "Enter");
};
const peer = (document: SheetsDocument) => subscriber.operation({
  type: "operation", senderId: "peer", revision: 1, upserts: [], deletes: [], replacedSheets: [], lastModified: 1,
  structure: { title: document.title, sheetOrder: document.sheetOrder, sheets: document.sheets },
});
const pointer = (target: EventTarget, type: string, x: number, y: number) => {
  // jsdom has MouseEvent, not PointerEvent; these handlers use their shared coordinates/button.
  target.dispatchEvent(new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }));
};
const startDrag = () => {
  pointer(element(".chart-card-head"), "pointerdown", 100, 100);
  pointer(window, "pointermove", 200, 140);
};

describe("Sheets client regressions", () => {
  it("retargets Delete synchronously when a peer filter hides the active cell", async () => {
    await mount();
    select("A2");
    const remote = structuredClone(initial);
    remote.sheets.sheet.filter = filter({ 0: ["s:keep"] });
    peer(remote);
    expect(element<HTMLInputElement>("input.namebox").value).toBe("A3");
    key(element(".grid-scroll"), "Delete"); // before the queued grid paint
    await frame();
    expect(cell("A2").textContent).toBe("drop");
    expect(cell("A3").textContent).toBe("");
    expect(cell("A2").parentElement!.style.display).toBe("none");
    expect(element<HTMLInputElement>("input.namebox").value).toBe("A4");
  });

  it("reconciles visibility after a peer changes a filtered cell's value", async () => {
    initial.sheets.sheet.filter = filter({ 0: ["s:keep"] });
    await mount();
    select("A3");
    subscriber.operation({ type: "operation", senderId: "peer", revision: 1, deletes: [], replacedSheets: [], lastModified: 1,
      structure: { title: initial.title, sheetOrder: initial.sheetOrder, sheets: structuredClone(initial.sheets) },
      upserts: [{ sheetId: "sheet", ref: "A3", cell: { value: "drop", fmt: null, version: 2 } }],
    });
    expect(element<HTMLInputElement>("input.namebox").value).toBe("A4");
    key(element(".grid-scroll"), "Delete");
    await frame();
    expect(cell("A3").textContent).toBe("drop");
  });

  it("moves to the visible header when a refreshed snapshot hides all data rows", async () => {
    await mount();
    select("A3");
    const remote = structuredClone(initial);
    remote.sheets.sheet.filter = { ...filter({ 0: ["x:__none__"] }), endRow: 7, rowOrder: [1, 2, 3, 4, 5, 6, 7] };
    subscriber.operation({ type: "snapshot", document: remote });
    expect(element<HTMLInputElement>("input.namebox").value).toBe("A1");
    await frame();
    expect(cell("A1").parentElement!.style.display).toBe("");
    expect(cell("A2").textContent).toBe("drop");
    expect(cell("A3").textContent).toBe("keep");
  });

  it("reconciles a local filter application before another keystroke", async () => {
    initial.sheets.sheet.filter = filter();
    await mount();
    select("A2");
    element<HTMLButtonElement>('td.cell[data-ref="A1"] button').click();
    const options = [...document.querySelectorAll<HTMLLabelElement>(".filter-option")];
    const drop = options.find(option => option.textContent === "drop")!;
    drop.querySelector<HTMLInputElement>("input")!.checked = false;
    [...document.querySelectorAll<HTMLButtonElement>(".filter-actions button")].find(button => button.textContent === "Apply")!.click();
    expect(element<HTMLInputElement>("input.namebox").value).toBe("A3");
    key(element(".grid-scroll"), "Delete");
    await frame();
    expect(cell("A2").textContent).toBe("drop");
    expect(cell("A3").textContent).toBe("");
  });

  it("cancels an edit hidden by a peer filter rather than committing it invisibly", async () => {
    await mount();
    select("A2");
    key(element(".grid-scroll"), "F2");
    const editor = element<HTMLTextAreaElement>("textarea.cell-editor");
    editor.value = "Uncommitted hidden edit";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    const remote = structuredClone(initial);
    remote.sheets.sheet.filter = filter({ 0: ["s:keep"] });
    peer(remote);
    key(element(".grid-scroll"), "Delete");
    await frame();
    expect(cell("A2").textContent).toBe("drop");
    expect(cell("A3").textContent).toBe("");
  });

  it("commits a drag to the live chart while preserving peer edits", async () => {
    await mount();
    startDrag();
    const remote = structuredClone(initial);
    remote.sheets.sheet.charts![0].title = "Peer title";
    remote.sheets.sheet.charts![0].legend = false;
    remote.sheets.sheet.comments = [{ id: "peer-comment", ref: "A3", text: "Peer comment", createdAt: 1, resolved: false }];
    peer(remote);
    await frame();
    pointer(window, "pointermove", 220, 150);
    pointer(window, "pointerup", 220, 150);
    expect(element<HTMLElement>(".chart-card").style.left).toBe("216px");
    expect(element<HTMLElement>(".chart-card").style.top).toBe("94px");
    expect(element(".chart-card-head strong").textContent).toBe("Peer title");
    expect(cell("A3").querySelector(".cell-comment-tooltip")!.textContent).toBe("Peer comment");
  });

  it("does not resurrect a chart deleted by a peer during its drag", async () => {
    await mount();
    startDrag();
    const remote = structuredClone(initial);
    remote.sheets.sheet.charts = [];
    peer(remote);
    await frame();
    pointer(window, "pointerup", 200, 140);
    expect(document.querySelector(".chart-card")).toBeNull();
  });

  it("does not apply a drag to a same-id chart on the newly active sheet", async () => {
    await mount();
    startDrag();
    element<HTMLElement>('.tab[data-id="other"]').click();
    await frame();
    pointer(window, "pointerup", 200, 140);
    expect(element<HTMLElement>(".chart-card").style.left).toBe("300px");
    expect(element<HTMLElement>(".chart-card").style.top).toBe("120px");
    expect(element(".chart-card-head strong").textContent).toBe("Other chart");
  });

  it("treats hyperlink labels as text without discarding links returned by IF", async () => {
    await mount();
    expect(cell("D2").textContent).toBe("Complete");
    expect(cell("D3").textContent).toBe("TRUE");
    expect(cell("D4").textContent).toBe("FALSE");
    expect(cell("D5").querySelector("a")!.href).toBe("https://example.com/");
    expect(cell("D6").textContent).toBe("TRUE");
    expect(cell("D7").textContent).toBe("TRUE");
    expect(cell("D8").textContent).toBe("");
  });
});
