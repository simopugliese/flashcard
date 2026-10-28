// Controlli sui corpi JSON delle richieste: ogni errore diventa un 400 con il messaggio (vedi app.onError).
export class ErroreValidazione extends Error {}

// Violazione di un indice UNIQUE (D1 la riporta nel messaggio o nella causa dell'errore).
export const èViolazioneUnicita = (e: unknown) => /UNIQUE constraint failed/i.test(`${e} ${(e as Error | undefined)?.cause}`);

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
  if (new Set(o).size !== o.length) return errore("le opzioni devono essere tutte diverse");
  return o.length ? o : null;
};

// Nel quiz le scelte si confrontano per testo: una opzione sbagliata uguale alla risposta renderebbe la carta ambigua.
const senzaRispostaTraOpzioni = <T extends string[] | null | undefined>(risposta: string | undefined, o: T) => {
  if (risposta !== undefined && o?.includes(risposta)) return errore("le opzioni sbagliate non possono contenere la risposta");
  return o;
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
  const risposta = testo(o.risposta, "risposta", 5000);
  return {
    domanda: testo(o.domanda, "domanda", 5000),
    risposta,
    opzioni: senzaRispostaTraOpzioni(risposta, se(o.opzioni, opzioni) ?? null),
    difficolta: se(o.difficolta, difficolta) ?? 3,
    id_argomento: id(o.id_argomento, "id_argomento"),
  };
};

export const leggiModificaCarta = (corpo: unknown) => {
  const o = oggetto(corpo, ["domanda", "risposta", "opzioni", "difficolta"], true);
  const risposta = se(o.risposta, (v) => testo(v, "risposta", 5000));
  return {
    domanda: se(o.domanda, (v) => testo(v, "domanda", 5000)),
    risposta,
    opzioni: senzaRispostaTraOpzioni(risposta, se(o.opzioni, opzioni)),
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
export const MAX_MATERIALI_IMPORT = 5000;
// Le spiegazioni AI non hanno un limite di lunghezza in scrittura: qui serve solo un tetto ragionevole.
export const MAX_TESTO_SPIEGAZIONE = 100_000;
// Data reale nel formato AAAA-MM-GG: Date.parse accetta anche giorni inesistenti (2026-02-31 diventa marzo),
// quindi si ricostruisce la data e si verifica che coincida con quella scritta.
const dataIso = (v: unknown, nome: string) => {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
  if (m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString().slice(0, 10) === v) return v as string;
  return errore(`${nome} deve essere una data AAAA-MM-GG`);
};

const elenco = (v: unknown, nome: string, max: number) =>
  Array.isArray(v) && v.length <= max ? (v as unknown[]) : errore(`${nome} deve essere un elenco di al massimo ${max} elementi`);

const istante = (v: unknown, nome: string) => intero(v, nome, 0, Number.MAX_SAFE_INTEGER);

// Un titolo di soli spazi (possibile nei nomi dei file caricati) diventa null invece di rendere l'archivio non importabile.
const titoloImport = (v: unknown) => titoloOpzionale(typeof v === "string" ? v.trim() : v);

// Materiale di un archivio v2: niente HTML (testo_render si ricalcola) e niente byte, solo l'hash del file in R2.
// `id` è il riferimento interno all'archivio usato dalle spiegazioni, non l'id che avrà nel database.
const materialeImport = (v: unknown) => {
  const tipo = (v as { tipo?: unknown } | null)?.tipo;
  if (tipo === "testo") {
    const o = oggetto(v, ["id", "tipo", "titolo", "testo", "creato_il"]);
    return {
      id: id(o.id, "id del materiale"),
      tipo: "testo" as const,
      titolo: titoloImport(o.titolo),
      testo: testo(o.testo, "testo", MAX_TESTO_MATERIALE),
      creato_il: istante(o.creato_il, "creato_il"),
    };
  }
  if (tipo === "file") {
    const o = oggetto(v, ["id", "tipo", "titolo", "hash", "mime", "dimensione", "creato_il"]);
    return {
      id: id(o.id, "id del materiale"),
      tipo: "file" as const,
      titolo: titoloImport(o.titolo),
      hash: typeof o.hash === "string" && /^[0-9a-f]{64}$/.test(o.hash) ? o.hash : errore("hash deve essere uno SHA-256 esadecimale"),
      mime: typeof o.mime === "string" && MIME_FILE.includes(o.mime) ? o.mime : errore(`mime deve essere uno tra: ${MIME_FILE.join(", ")}`),
      dimensione: intero(o.dimensione, "dimensione", 1, MAX_FILE_BYTES),
      creato_il: istante(o.creato_il, "creato_il"),
    };
  }
  return errore("il tipo di un materiale deve essere testo o file");
};

// Spiegazione di un archivio v2: `materiali` sono id d'archivio, ammessi solo tra quelli della carta e del suo argomento.
const spiegazioneImport = (v: unknown, disponibili: Set<number>) => {
  if (v === null) return null;
  const o = oggetto(v, ["testo", "fonte", "modello", "materiali", "obsoleta", "creata_il"]);
  const fonte: "manuale" | "ai" = o.fonte === "manuale" || o.fonte === "ai" ? o.fonte : errore("fonte deve essere manuale o ai");
  const modello = o.modello === null ? null : testo(o.modello, "modello", 100);
  if (fonte === "manuale" && modello !== null) return errore("una spiegazione manuale non ha modello");
  if (typeof o.obsoleta !== "boolean") return errore("obsoleta deve essere true o false");
  const materiali = se(o.materiali, idMateriali) ?? [];
  if (materiali.some((m) => !disponibili.has(m))) return errore("una spiegazione usa materiali che non sono della sua carta né del suo argomento");
  return {
    testo: testo(o.testo, "testo della spiegazione", MAX_TESTO_SPIEGAZIONE),
    fonte,
    modello,
    materiali,
    obsoleta: o.obsoleta,
    creata_il: istante(o.creata_il, "creata_il"),
  };
};

const CAMPI_CARTA_IMPORT = ["domanda", "risposta", "opzioni", "difficolta", "ripasso"];

// Archivio esportato da GET /esporta: versione 1 (solo carte e ripassi) o 2 (anche materiali e spiegazioni).
// Convalida tutto prima di scrivere qualsiasi cosa; una v1 esce con `materiali: []` e `spiegazione: null`.
export const leggiImportazione = (corpo: unknown) => {
  const o = oggetto(corpo, ["versione", "materie"]);
  if (o.versione !== 1 && o.versione !== 2) return errore("versione non supportata");
  const v2 = o.versione === 2;
  let carte = 0;
  let materiali = 0;
  const idVisti = new Set<number>();
  // Gli id dei materiali sono unici in tutto l'archivio: servono a rimappare i riferimenti delle spiegazioni.
  const elencoMateriali = (v: unknown, maxFile: number, di: string) => {
    const lista = elenco(v ?? [], "materiali", MAX_MATERIALI_IMPORT).map((x) => {
      if (++materiali > MAX_MATERIALI_IMPORT) return errore(`al massimo ${MAX_MATERIALI_IMPORT} materiali per importazione`);
      const m = materialeImport(x);
      if (idVisti.has(m.id)) return errore(`id del materiale ripetuto: ${m.id}`);
      idVisti.add(m.id);
      return m;
    });
    if (lista.filter((m) => m.tipo === "file").length > maxFile) return errore(`al massimo ${maxFile} file per ${di}`);
    return lista;
  };
  const materie = elenco(o.materie, "materie", 1000).map((m) => {
    const mo = oggetto(m, ["nome_materia", "argomenti"]);
    return {
      nome_materia: testo(mo.nome_materia, "nome_materia", 100),
      argomenti: elenco(mo.argomenti, "argomenti", 1000).map((a) => {
        const ao = oggetto(a, v2 ? ["nome_argomento", "materiali", "carte"] : ["nome_argomento", "carte"]);
        const materialiArgomento = elencoMateriali(ao.materiali, MAX_FILE_PER_ARGOMENTO, "argomento");
        return {
          nome_argomento: testo(ao.nome_argomento, "nome_argomento", 100),
          materiali: materialiArgomento,
          carte: elenco(ao.carte, "carte", MAX_CARTE_IMPORT).map((k) => {
            if (++carte > MAX_CARTE_IMPORT) return errore(`al massimo ${MAX_CARTE_IMPORT} carte per importazione`);
            const ko = oggetto(k, v2 ? [...CAMPI_CARTA_IMPORT, "materiali", "spiegazione"] : CAMPI_CARTA_IMPORT);
            const materialiCarta = elencoMateriali(ko.materiali, MAX_FILE_PER_CARTA, "carta");
            const disponibili = new Set([...materialiArgomento, ...materialiCarta].map((x) => x.id));
            if (ko.ripasso === undefined) return errore("ogni carta deve avere il campo ripasso");
            const ro = oggetto(ko.ripasso, ["ultimo_ripasso", "prossimo_ripasso", "media_esito", "numero_ripassi"]);
            const media = ro.media_esito;
            const risposta = testo(ko.risposta, "risposta", 5000);
            const ultimo = ro.ultimo_ripasso === null ? null : dataIso(ro.ultimo_ripasso, "ultimo_ripasso");
            const prossimo = dataIso(ro.prossimo_ripasso, "prossimo_ripasso");
            if (ultimo && ultimo > prossimo) return errore("ultimo_ripasso non può essere successivo a prossimo_ripasso");
            return {
              domanda: testo(ko.domanda, "domanda", 5000),
              risposta,
              opzioni: senzaRispostaTraOpzioni(risposta, se(ko.opzioni, opzioni) ?? null),
              difficolta: difficolta(ko.difficolta),
              ripasso: {
                ultimo_ripasso: ultimo,
                prossimo_ripasso: prossimo,
                media_esito: typeof media === "number" && media >= 0 && media <= 5 ? media : errore("media_esito deve essere un numero da 0 a 5"),
                numero_ripassi: intero(ro.numero_ripassi, "numero_ripassi", 0, 1_000_000),
              },
              materiali: materialiCarta,
              spiegazione: ko.spiegazione === undefined ? null : spiegazioneImport(ko.spiegazione, disponibili),
            };
          }),
        };
      }),
    };
  });
  return { materie };
};

// Limiti dei materiali. 2 MB per file: su una materia da ~1000 carte il totale resta gestibile (il frontend ricomprime le immagini).
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_PER_CARTA = 3;
export const MAX_FILE_PER_ARGOMENTO = 150;
export const MAX_TESTO_MATERIALE = 20000;

// Solo formati che il browser non esegue: niente SVG né HTML (XSS). Il tipo dichiarato dal client non basta,
// quindi si confronta con i primi byte del file.
const FIRME: Record<string, (b: Uint8Array) => boolean> = {
  "image/png": (b) => [0x89, 0x50, 0x4e, 0x47].every((x, i) => b[i] === x),
  "image/jpeg": (b) => [0xff, 0xd8, 0xff].every((x, i) => b[i] === x),
  "image/gif": (b) => [..."GIF8"].every((x, i) => b[i] === x.charCodeAt(0)),
  "image/webp": (b) => [..."RIFF"].every((x, i) => b[i] === x.charCodeAt(0)) && [..."WEBP"].every((x, i) => b[8 + i] === x.charCodeAt(0)),
  "application/pdf": (b) => [..."%PDF"].every((x, i) => b[i] === x.charCodeAt(0)),
  "text/plain": (b) => !b.subarray(0, 1024).includes(0),
};
export const MIME_FILE = Object.keys(FIRME);

// Verifica tipo, dimensione e contenuto di un file caricato; restituisce il tipo normalizzato.
export const controllaFile = (mime: string, byte: Uint8Array) => {
  const tipo = mime.split(";")[0].trim().toLowerCase();
  if (!FIRME[tipo]) return errore(`tipo di file non ammesso (ammessi: ${MIME_FILE.join(", ")})`);
  if (!byte.length) return errore("il file è vuoto");
  if (byte.length > MAX_FILE_BYTES) return errore(`il file supera il limite di ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  if (!FIRME[tipo](byte)) return errore("il contenuto del file non corrisponde al tipo dichiarato");
  return tipo;
};

const titoloOpzionale = (v: unknown) => (v === undefined || v === null || v === "" ? null : testo(v, "titolo", 100));

export const leggiNuovaNota = (corpo: unknown) => {
  const o = oggetto(corpo, ["titolo", "testo"]);
  return { titolo: titoloOpzionale(o.titolo), testo: testo(o.testo, "testo", MAX_TESTO_MATERIALE) };
};

// Modifica di un materiale: il testo ha senso solo per le note (lo verifica la rotta, che conosce il tipo).
export const leggiModificaMateriale = (corpo: unknown) => {
  const o = oggetto(corpo, ["titolo", "testo"], true);
  return { titolo: o.titolo === undefined ? undefined : titoloOpzionale(o.titolo), testo: se(o.testo, (v) => testo(v, "testo", MAX_TESTO_MATERIALE)) };
};

// Spiegazioni: `materiali` sono gli id dei materiali (della carta o del suo argomento) dati come contesto.
export const MAX_MATERIALI_SPIEGAZIONE = 20;

const idMateriali = (v: unknown) => {
  const ids = elenco(v, "materiali", MAX_MATERIALI_SPIEGAZIONE).map((x) => id(x, "ogni materiale"));
  if (new Set(ids).size !== ids.length) return errore("i materiali devono essere tutti diversi");
  return ids;
};

export const leggiSpiegazioneManuale = (corpo: unknown) => {
  const o = oggetto(corpo, ["testo", "materiali"]);
  return { testo: testo(o.testo, "testo", MAX_TESTO_MATERIALE), materiali: se(o.materiali, idMateriali) ?? [] };
};

export const leggiRichiestaGenera = (corpo: unknown) => {
  const o = oggetto(corpo, ["materiali", "rigenera"]);
  if (o.rigenera !== undefined && typeof o.rigenera !== "boolean") return errore("rigenera deve essere true o false");
  return { materiali: se(o.materiali, idMateriali) ?? [], rigenera: o.rigenera === true };
};

export const leggiRichiestaPrompt = (corpo: unknown) => ({ materiali: se(oggetto(corpo, ["materiali"]).materiali, idMateriali) ?? [] });

export const leggiVoto =(corpo: unknown) => intero(oggetto(corpo, ["voto"]).voto, "voto", 0, 5);

export const inesistente = (nome: string) => errore(`${nome} inesistente`);
