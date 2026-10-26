// Controlli sui corpi JSON delle richieste: ogni errore diventa un 400 con il messaggio (vedi app.onError).
export class ErroreValidazione extends Error {}

const errore = (messaggio: string): never => {
  throw new ErroreValidazione(messaggio);
};

const testo = (v: unknown, nome: string, max: number) => {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t) return errore(`${nome} deve essere un testo non vuoto`);
  if (t.length > max) return errore(`${nome} può avere al massimo ${max} caratteri`);
  return t;
};

const intero = (v: unknown, nome: string, min: number, max: number) =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : errore(`${nome} deve essere un intero da ${min} a ${max}`);

const id = (v: unknown, nome: string) => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : errore(`${nome} deve essere un intero positivo`));

const difficolta = (v: unknown) => intero(v, "difficolta", 1, 5);

// Opzioni sbagliate: null oppure fino a 9 testi, come nel frontend; un elenco vuoto diventa null.
const opzioni = (v: unknown) => {
  if (v === null) return null;
  if (!Array.isArray(v) || v.length > 9) return errore("opzioni deve essere null o un elenco di al massimo 9 testi");
  const o = v.map((x) => testo(x, "ogni opzione", 500));
  return o.length ? o : null;
};

// Accetta solo un oggetto con i campi previsti; in modifica (parziale) ne serve almeno uno.
const oggetto = (corpo: unknown, campi: string[], parziale = false) => {
  if (typeof corpo !== "object" || corpo === null || Array.isArray(corpo)) return errore("il corpo deve essere un oggetto JSON");
  const o = corpo as Record<string, unknown>;
  const ignoti = Object.keys(o).filter((k) => !campi.includes(k));
  if (ignoti.length) return errore(`campi non previsti: ${ignoti.join(", ")}`);
  if (parziale && !Object.keys(o).length) return errore("nessun campo da modificare");
  return o;
};

const se = <T>(v: unknown, leggi: (v: unknown) => T) => (v === undefined ? undefined : leggi(v));

export const idPercorso = (s: string | undefined) => (/^[1-9]\d{0,14}$/.test(s ?? "") ? Number(s) : errore("id non valido"));

export const leggiMateria = (corpo: unknown) => ({ nome_materia: testo(oggetto(corpo, ["nome_materia"]).nome_materia, "nome_materia", 100) });

export const leggiNuovoArgomento = (corpo: unknown) => {
  const o = oggetto(corpo, ["nome_argomento", "id_materia"]);
  return { nome_argomento: testo(o.nome_argomento, "nome_argomento", 100), id_materia: id(o.id_materia, "id_materia") };
};

export const leggiModificaArgomento = (corpo: unknown) => ({
  nome_argomento: testo(oggetto(corpo, ["nome_argomento"]).nome_argomento, "nome_argomento", 100),
});

// Senza difficoltà la carta parte da 3 (neutra): il default della colonna nel DB è ancora 1.
export const leggiNuovaCarta = (corpo: unknown) => {
  const o = oggetto(corpo, ["domanda", "risposta", "opzioni", "difficolta", "id_argomento"]);
  return {
    domanda: testo(o.domanda, "domanda", 5000),
    risposta: testo(o.risposta, "risposta", 5000),
    opzioni: se(o.opzioni, opzioni) ?? null,
    difficolta: se(o.difficolta, difficolta) ?? 3,
    id_argomento: id(o.id_argomento, "id_argomento"),
  };
};

export const leggiModificaCarta = (corpo: unknown) => {
  const o = oggetto(corpo, ["domanda", "risposta", "opzioni", "difficolta"], true);
  return {
    domanda: se(o.domanda, (v) => testo(v, "domanda", 5000)),
    risposta: se(o.risposta, (v) => testo(v, "risposta", 5000)),
    opzioni: se(o.opzioni, opzioni),
    difficolta: se(o.difficolta, difficolta),
  };
};

export const MODI_RIPASSO = ["scadenza", "anticipo", "tutte"] as const;
export type FiltroRipasso = {
  idMateria?: number;
  argomenti?: number[];
  modo: (typeof MODI_RIPASSO)[number];
  casuale: boolean;
  limite?: number;
};

const numeroQuery = (v: string, nome: string, min: number, max: number) =>
  /^\d{1,15}$/.test(v) ? intero(Number(v), nome, min, max) : errore(`${nome} deve essere un intero da ${min} a ${max}`);

// Parametri della query di /carte/da-ripassare (tutti opzionali).
export const leggiFiltroRipasso = (q: Record<string, string>): FiltroRipasso => {
  const modo = q.modo ?? "scadenza";
  if (!(MODI_RIPASSO as readonly string[]).includes(modo)) return errore(`modo deve essere uno tra: ${MODI_RIPASSO.join(", ")}`);
  if (q.casuale !== undefined && !["0", "1"].includes(q.casuale)) return errore("casuale deve essere 0 o 1");
  const argomenti = q.argomenti === undefined ? undefined : q.argomenti.split(",").map((v) => numeroQuery(v, "argomenti", 1, Number.MAX_SAFE_INTEGER));
  return {
    idMateria: q.materia === undefined ? undefined : numeroQuery(q.materia, "materia", 1, Number.MAX_SAFE_INTEGER),
    argomenti,
    modo: modo as FiltroRipasso["modo"],
    casuale: q.casuale === "1",
    limite: q.limite === undefined ? undefined : numeroQuery(q.limite, "limite", 1, 500),
  };
};

export const MAX_CARTE_IMPORT = 5000;
// Data reale nel formato AAAA-MM-GG: Date.parse accetta anche giorni inesistenti (2026-02-31 diventa marzo),
// quindi si ricostruisce la data e si verifica che coincida con quella scritta.
const dataIso = (v: unknown, nome: string) => {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
  if (m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString().slice(0, 10) === v) return v as string;
  return errore(`${nome} deve essere una data AAAA-MM-GG`);
};

const elenco = (v: unknown, nome: string, max: number) =>
  Array.isArray(v) && v.length <= max ? (v as unknown[]) : errore(`${nome} deve essere un elenco di al massimo ${max} elementi`);

// Archivio esportato da GET /esporta (versione 1). Convalida tutto prima di scrivere qualsiasi cosa.
export const leggiImportazione = (corpo: unknown) => {
  const o = oggetto(corpo, ["versione", "materie"]);
  if (o.versione !== 1) return errore("versione non supportata");
  let carte = 0;
  const materie = elenco(o.materie, "materie", 1000).map((m) => {
    const mo = oggetto(m, ["nome_materia", "argomenti"]);
    return {
      nome_materia: testo(mo.nome_materia, "nome_materia", 100),
      argomenti: elenco(mo.argomenti, "argomenti", 1000).map((a) => {
        const ao = oggetto(a, ["nome_argomento", "carte"]);
        return {
          nome_argomento: testo(ao.nome_argomento, "nome_argomento", 100),
          carte: elenco(ao.carte, "carte", MAX_CARTE_IMPORT).map((k) => {
            if (++carte > MAX_CARTE_IMPORT) return errore(`al massimo ${MAX_CARTE_IMPORT} carte per importazione`);
            const ko = oggetto(k, ["domanda", "risposta", "opzioni", "difficolta", "ripasso"]);
            const ro = oggetto(ko.ripasso, ["ultimo_ripasso", "prossimo_ripasso", "media_esito", "numero_ripassi"]);
            const media = ro.media_esito;
            return {
              domanda: testo(ko.domanda, "domanda", 5000),
              risposta: testo(ko.risposta, "risposta", 5000),
              opzioni: se(ko.opzioni, opzioni) ?? null,
              difficolta: difficolta(ko.difficolta),
              ripasso: {
                ultimo_ripasso: ro.ultimo_ripasso === null ? null : dataIso(ro.ultimo_ripasso, "ultimo_ripasso"),
                prossimo_ripasso: dataIso(ro.prossimo_ripasso, "prossimo_ripasso"),
                media_esito: typeof media === "number" && media >= 0 && media <= 5 ? media : errore("media_esito deve essere un numero da 0 a 5"),
                numero_ripassi: intero(ro.numero_ripassi, "numero_ripassi", 0, 1_000_000),
              },
            };
          }),
        };
      }),
    };
  });
  return { materie };
};

export const leggiVoto = (corpo: unknown) => intero(oggetto(corpo, ["voto"]).voto, "voto", 0, 5);

export const inesistente = (nome: string) => errore(`${nome} inesistente`);
