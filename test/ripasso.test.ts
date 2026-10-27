import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calcolaRipasso, oggi } from "../src/ripasso";

const r = (o: Partial<Parameters<typeof calcolaRipasso>[0]> = {}) => ({
  id_carta: 1,
  ultimo_ripasso: null,
  prossimo_ripasso: "2026-03-10",
  media_esito: 0,
  numero_ripassi: 0,
  ...o,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-10T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("oggi", () => {
  it("usa la data italiana, non UTC", () => {
    vi.setSystemTime(new Date("2026-03-10T23:30:00Z")); // già l'11 a Roma
    expect(oggi()).toBe("2026-03-11");
  });
  it("somma giorni di calendario anche oltre il cambio dell'ora legale", () => {
    vi.setSystemTime(new Date("2026-03-27T12:00:00Z"));
    expect(oggi(3)).toBe("2026-03-30");
  });
});

describe("calcolaRipasso", () => {
  it("un voto sotto 3 rimanda a domani", () => {
    expect(calcolaRipasso(r({ numero_ripassi: 4, media_esito: 4 }), 2, 3).prossimo_ripasso).toBe("2026-03-11");
  });
  it("aggiorna media e numero di ripassi", () => {
    const n = calcolaRipasso(r({ numero_ripassi: 1, media_esito: 4 }), 2, 3);
    expect(n.numero_ripassi).toBe(2);
    expect(n.media_esito).toBe(3);
    expect(n.ultimo_ripasso).toBe("2026-03-10");
  });
  it("il primo ripasso con voto 3 e difficoltà neutra torna dopo 3 giorni", () => {
    expect(calcolaRipasso(r({ prossimo_ripasso: "2026-03-10" }), 3, 3).prossimo_ripasso).toBe("2026-03-13");
  });
  it("la difficoltà alta accorcia l'intervallo, quella bassa lo allunga", () => {
    const giorni = (dif: number) => Date.parse(calcolaRipasso(r(), 5, dif).prossimo_ripasso) - Date.parse("2026-03-10");
    expect(giorni(5)).toBeLessThan(giorni(3));
    expect(giorni(1)).toBeGreaterThan(giorni(3));
  });
  it("l'intervallo ha un tetto di 365 giorni", () => {
    const n = calcolaRipasso(r({ numero_ripassi: 100_000, media_esito: 5 }), 5, 1);
    expect(n.prossimo_ripasso).toBe(oggi(365));
  });
  it("un ripasso in anticipo con buon voto non accorcia la scadenza", () => {
    expect(calcolaRipasso(r({ prossimo_ripasso: "2027-01-01" }), 4, 3).prossimo_ripasso).toBe("2027-01-01");
  });
  it("un voto basso in anticipo invece riporta la carta a domani", () => {
    expect(calcolaRipasso(r({ prossimo_ripasso: "2027-01-01" }), 1, 3).prossimo_ripasso).toBe("2026-03-11");
  });
});
