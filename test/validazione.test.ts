import { describe, expect, it } from "vitest";
import {
  ErroreValidazione,
  èViolazioneUnicita,
  controllaFile,
  idPercorso,
  leggiFiltroRipasso,
  leggiImportazione,
  leggiModificaCarta,
  leggiModificaMateriale,
  leggiNuovaNota,
  MAX_FILE_BYTES,
  leggiNuovaCarta,
  leggiRichiestaGenera,
  leggiRichiestaPrompt,
  leggiSpiegazioneManuale,
  leggiVoto,
} from "../src/validazione";

const errore = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ErroreValidazione);
    return (e as Error).message;
  }
  throw new Error("nessun errore lanciato");
};

describe("leggiNuovaCarta", () => {
  const base = { domanda: " D ", risposta: "R", id_argomento: 1 };
  it("applica i default e rimuove gli spazi", () => {
    expect(leggiNuovaCarta(base)).toEqual({ domanda: "D", risposta: "R", opzioni: null, difficolta: 3, id_argomento: 1 });
  });
  it("rifiuta campi non previsti", () => {
    expect(errore(() => leggiNuovaCarta({ ...base, x: 1 }))).toMatch(/campi non previsti/);
  });
  it("rifiuta opzioni duplicate o uguali alla risposta", () => {
    expect(errore(() => leggiNuovaCarta({ ...base, opzioni: ["a", "a"] }))).toMatch(/diverse/);
    expect(errore(() => leggiNuovaCarta({ ...base, opzioni: ["a", "R"] }))).toMatch(/risposta/);
  });
  it("rifiuta più di 9 opzioni e difficoltà fuori scala", () => {
    expect(errore(() => leggiNuovaCarta({ ...base, opzioni: Array.from({ length: 10 }, (_, i) => `o${i}`) }))).toMatch(/9/);
    expect(errore(() => leggiNuovaCarta({ ...base, difficolta: 6 }))).toMatch(/difficolta/);
  });
  it("un elenco di opzioni vuoto diventa null", () => {
    expect(leggiNuovaCarta({ ...base, opzioni: [] }).opzioni).toBeNull();
  });
});

describe("leggiModificaCarta", () => {
  it("richiede almeno un campo", () => {
    expect(errore(() => leggiModificaCarta({}))).toMatch(/nessun campo/);
  });
  it("controlla la risposta tra le opzioni quando arrivano insieme", () => {
    expect(errore(() => leggiModificaCarta({ risposta: "R", opzioni: ["R"] }))).toMatch(/risposta/);
  });
});

describe("leggiVoto e idPercorso", () => {
  it("accetta solo interi da 0 a 5", () => {
    expect(leggiVoto({ voto: 0 })).toBe(0);
    errore(() => leggiVoto({ voto: 6 }));
    errore(() => leggiVoto({ voto: 2.5 }));
  });
  it("accetta solo id positivi", () => {
    expect(idPercorso("12")).toBe(12);
    errore(() => idPercorso("0"));
    errore(() => idPercorso("1a"));
  });
});

describe("leggiFiltroRipasso", () => {
  it("usa i default", () => {
    expect(leggiFiltroRipasso({})).toMatchObject({ modo: "scadenza", casuale: false });
  });
  it("legge argomenti e limite e rifiuta valori errati", () => {
    expect(leggiFiltroRipasso({ argomenti: "1,2", limite: "10", casuale: "1" })).toMatchObject({ argomenti: [1, 2], limite: 10, casuale: true });
    errore(() => leggiFiltroRipasso({ modo: "boh" }));
    errore(() => leggiFiltroRipasso({ limite: "501" }));
  });
});

describe("leggiImportazione", () => {
  const carta = (o: object = {}) => ({
    domanda: "D",
    risposta: "R",
    opzioni: null,
    difficolta: 3,
    ripasso: { ultimo_ripasso: null, prossimo_ripasso: "2026-03-10", media_esito: 0, numero_ripassi: 0 },
    ...o,
  });
  const archivio = (k: object) => ({ versione: 1, materie: [{ nome_materia: "M", argomenti: [{ nome_argomento: "A", carte: [k] }] }] });

  it("accetta un archivio valido", () => {
    expect(leggiImportazione(archivio(carta())).materie[0].argomenti[0].carte).toHaveLength(1);
  });
  it("rifiuta versioni sconosciute", () => {
    expect(errore(() => leggiImportazione({ versione: 2, materie: [] }))).toMatch(/versione/);
  });
  it("rifiuta date inesistenti", () => {
    const ripasso = { ultimo_ripasso: null, prossimo_ripasso: "2026-02-31", media_esito: 0, numero_ripassi: 0 };
    expect(errore(() => leggiImportazione(archivio(carta({ ripasso }))))).toMatch(/prossimo_ripasso/);
  });
  it("rifiuta un ultimo ripasso successivo al prossimo", () => {
    const ripasso = { ultimo_ripasso: "2026-04-01", prossimo_ripasso: "2026-03-10", media_esito: 3, numero_ripassi: 1 };
    expect(errore(() => leggiImportazione(archivio(carta({ ripasso }))))).toMatch(/successivo/);
  });
  it("segnala il ripasso mancante", () => {
    const { ripasso: _, ...senza } = carta();
    expect(errore(() => leggiImportazione(archivio(senza)))).toMatch(/ripasso/);
  });
  it("rifiuta media fuori scala", () => {
    const ripasso = { ultimo_ripasso: null, prossimo_ripasso: "2026-03-10", media_esito: 7, numero_ripassi: 0 };
    expect(errore(() => leggiImportazione(archivio(carta({ ripasso }))))).toMatch(/media_esito/);
  });
});

describe("èViolazioneUnicita", () => {
  it("riconosce l'errore nel messaggio o nella causa", () => {
    expect(èViolazioneUnicita(new Error("D1_ERROR: UNIQUE constraint failed: materia.nome_materia"))).toBe(true);
    expect(èViolazioneUnicita(new Error("query fallita", { cause: new Error("UNIQUE constraint failed: argomento.nome_argomento") }))).toBe(true);
  });
  it("ignora gli altri errori", () => {
    expect(èViolazioneUnicita(new Error("NOT NULL constraint failed"))).toBe(false);
    expect(èViolazioneUnicita(undefined)).toBe(false);
  });
});

describe("controllaFile", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0]);
  it("accetta un file coerente col tipo dichiarato e normalizza il tipo", () => {
    expect(controllaFile("IMAGE/PNG; charset=x", png)).toBe("image/png");
    expect(controllaFile("application/pdf", new TextEncoder().encode("%PDF-1.7"))).toBe("application/pdf");
  });
  it("rifiuta SVG e HTML", () => {
    expect(errore(() => controllaFile("image/svg+xml", new TextEncoder().encode("<svg/>")))).toMatch(/non ammesso/);
    expect(errore(() => controllaFile("text/html", new TextEncoder().encode("<b>")))).toMatch(/non ammesso/);
  });
  it("rifiuta un contenuto che non corrisponde al tipo", () => {
    expect(errore(() => controllaFile("image/jpeg", png))).toMatch(/non corrisponde/);
    expect(errore(() => controllaFile("text/plain", Uint8Array.from([65, 0, 66])))).toMatch(/non corrisponde/);
  });
  it("rifiuta file vuoti o sopra il limite", () => {
    expect(errore(() => controllaFile("image/png", new Uint8Array()))).toMatch(/vuoto/);
    const grande = new Uint8Array(MAX_FILE_BYTES + 1);
    grande.set(png);
    expect(errore(() => controllaFile("image/png", grande))).toMatch(/limite/);
  });
});

describe("note dei materiali", () => {
  it("leggiNuovaNota: titolo facoltativo, testo obbligatorio", () => {
    expect(leggiNuovaNota({ testo: " $x^2$ " })).toEqual({ titolo: null, testo: "$x^2$" });
    expect(errore(() => leggiNuovaNota({ titolo: "T" }))).toMatch(/testo/);
  });
  it("leggiModificaMateriale: serve almeno un campo e il titolo vuoto lo azzera", () => {
    expect(errore(() => leggiModificaMateriale({}))).toMatch(/nessun campo/);
    expect(leggiModificaMateriale({ titolo: "" })).toEqual({ titolo: null, testo: undefined });
  });
});

describe("spiegazioni", () => {
  it("leggiSpiegazioneManuale: testo obbligatorio, materiali facoltativi", () => {
    expect(leggiSpiegazioneManuale({ testo: " perché $x$ " })).toEqual({ testo: "perché $x$", materiali: [] });
    expect(leggiSpiegazioneManuale({ testo: "t", materiali: [2, 1] })).toEqual({ testo: "t", materiali: [2, 1] });
    expect(errore(() => leggiSpiegazioneManuale({ materiali: [] }))).toMatch(/testo/);
  });
  it("leggiRichiestaGenera: rigenera booleano, default false", () => {
    expect(leggiRichiestaGenera({})).toEqual({ materiali: [], rigenera: false });
    expect(leggiRichiestaGenera({ materiali: [3], rigenera: true })).toEqual({ materiali: [3], rigenera: true });
    expect(errore(() => leggiRichiestaGenera({ rigenera: 1 }))).toMatch(/rigenera/);
  });
  it("rifiuta materiali duplicati, non validi o troppi", () => {
    expect(errore(() => leggiRichiestaPrompt({ materiali: [1, 1] }))).toMatch(/diversi/);
    expect(errore(() => leggiRichiestaPrompt({ materiali: [0] }))).toMatch(/intero positivo/);
    expect(errore(() => leggiRichiestaPrompt({ materiali: Array.from({ length: 21 }, (_, i) => i + 1) }))).toMatch(/20/);
    expect(errore(() => leggiRichiestaPrompt({ x: 1 }))).toMatch(/campi non previsti/);
  });
});
