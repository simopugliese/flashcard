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

export const leggiVoto = (corpo: unknown) => intero(oggetto(corpo, ["voto"]).voto, "voto", 0, 5);

export const inesistente = (nome: string) => errore(`${nome} inesistente`);
