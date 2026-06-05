import { bindLegacyExport } from "./legacySvelteBinding";

describe("bindLegacyExport", () => {
  test("wires Svelte 3 bound callbacks by compiled prop index", () => {
    const seen: unknown[] = [];
    const legacyInstance = {
      $$: {
        props: { displayedMonth: 0 },
        bound: {} as Record<number, (value: unknown) => void>,
      },
    };

    const didBind = bindLegacyExport(
      legacyInstance,
      "displayedMonth",
      (value) => seen.push(value)
    );

    expect(didBind).toBe(true);
    expect(typeof legacyInstance.$$.bound[0]).toBe("function");

    legacyInstance.$$.bound[0]("2026-05");

    expect(seen).toEqual(["2026-05"]);
  });
});
