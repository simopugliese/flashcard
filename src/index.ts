import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, getTableColumns, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { materia, argomento, carta, materiale, ripasso, spiegazione } from "./schema";
import { rendi } from "./render";
import { carteDaRipassare, oggi, registraVoto } from "./ripasso";
import { gestisciUpdate, invioProgrammato, segretoValido, type Env } from "./telegram";
import materiali, { eliminaOrfani, hashArgomento, hashCarta, hashMateria } from "./materiali";
import spiegazioni from "./spiegazioni";
import { ErroreProvider, impronta } from "./ai";
import {
  ErroreValidazione,
  MAX_FILE_PER_ARGOMENTO,
  èViolazioneUnicita,
  idPercorso,
  inesistente,
  leggiFiltroRipasso,
  leggiImportazione,
  leggiMateria,
  leggiModificaArgomento,
  leggiModificaCarta,
  leggiNuovaCarta,
  leggiNuovoArgomento,
  leggiVoto,
} from "./validazione";

const app = new Hono<{ Bindings: Env }>();
const db = (c: { env: { DB: D1Database } }) => drizzle(c.env.DB);
const id = (c: { req: { param: (nome: "id") => string | undefined } }) => idPercorso(c.req.param("id"));

// Dati non validi o JSON rotto: 400 col messaggio. Il resto è un errore interno: si registra e non si espone.
app.onError((e, c) => {
  if (e instanceof ErroreValidazione || e instanceof SyntaxError) return c.json({ errore: e.message }, 400);
  if (e instanceof HTTPException) return e.getResponse();
  if (èViolazioneUnicita(e)) return c.json({ errore: "esiste già un elemento con questo nome" }, 409);
  console.error(e);
  if (e instanceof ErroreProvider) return c.json({ errore: "il provider AI non ha risposto correttamente, riprova" }, 502);
  return c.json({ errore: "errore interno" }, 500);
});

app.route("/", materiali);
app.route("/", spiegazioni);

app.get("/materie", async (c) => c.json(await db(c).select().from(materia).orderBy(materia.nome_materia, materia.id_materia)));

app.get("/materie/:id", async (c) => {
  const [m] = await db(c).select().from(materia).where(eq(materia.id_materia, id(c)));
  return m ? c.json(m) : c.notFound();
});

app.post("/materie", async (c) => {
  const [m] = await db(c).insert(materia).values(leggiMateria(await c.req.json())).returning();
  return c.json(m, 201);
});

app.put("/materie/:id", async (c) => {
  const [m] = await db(c).update(materia).set(leggiMateria(await c.req.json())).where(eq(materia.id_materia, id(c))).returning();
  return m ? c.json(m) : c.notFound();
});

// Le cancellazioni a cascata portano via anche i materiali: si leggono prima gli hash dei file per ripulire R2 dopo.
app.delete("/materie/:id", async (c) => {
  const d = db(c);
  const hash = await hashMateria(d, id(c));
  const eliminate = await d.delete(materia).where(eq(materia.id_materia, id(c))).returning({ id: materia.id_materia });
  if (!eliminate.length) return c.notFound();
  await eliminaOrfani(c.env, d, hash);
  return c.body(null, 204);
});

// Media pesata sui ripassi e sulla difficoltà: media_esito * numero_ripassi è la somma dei voti della carta, quindi
// senza il peso sarebbe la media di tutti i voti dati nell'argomento. Ogni voto pesa quanto la difficoltà della carta.
// Le carte mai ripassate pesano 0; senza ripassi la media è null.
app.get("/materie/:id/argomenti", async (c) =>
  c.json(
    await db(c)
      .select({
        ...getTableColumns(argomento),
        media: sql<number | null>`sum(${ripasso.media_esito} * ${ripasso.numero_ripassi} * ${carta.difficolta}) * 1.0 / nullif(sum(${ripasso.numero_ripassi} * ${carta.difficolta}), 0)`,
        ripassi: sql<number>`coalesce(sum(${ripasso.numero_ripassi}), 0)`,
      })
      .from(argomento)
      .leftJoin(carta, eq(carta.id_argomento, argomento.id_argomento))
      .leftJoin(ripasso, eq(ripasso.id_carta, carta.id_carta))
      .where(eq(argomento.id_materia, id(c)))
      .groupBy(argomento.id_argomento)
      .orderBy(argomento.nome_argomento, argomento.id_argomento),
  ),
);

app.get("/materie/:id/carte", async (c) =>
  c.json(
    await db(c)
      .select({ ...getTableColumns(carta), nome_argomento: argomento.nome_argomento })
      .from(carta)
      .innerJoin(argomento, eq(argomento.id_argomento, carta.id_argomento))
      .where(eq(argomento.id_materia, id(c)))
      .orderBy(carta.id_carta),
  ),
);

app.get("/argomenti/:id", async (c) => {
  const [a] = await db(c).select().from(argomento).where(eq(argomento.id_argomento, id(c)));
  return a ? c.json(a) : c.notFound();
});

app.post("/argomenti", async (c) => {
  const dati = leggiNuovoArgomento(await c.req.json());
  const [m] = await db(c).select({ id: materia.id_materia }).from(materia).where(eq(materia.id_materia, dati.id_materia));
  if (!m) return inesistente("materia");
  const [a] = await db(c).insert(argomento).values(dati).returning();
  return c.json(a, 201);
});

app.put("/argomenti/:id", async (c) => {
  const [a] = await db(c).update(argomento).set(leggiModificaArgomento(await c.req.json())).where(eq(argomento.id_argomento, id(c))).returning();
  return a ? c.json(a) : c.notFound();
});

app.delete("/argomenti/:id", async (c) => {
  const d = db(c);
  const hash = await hashArgomento(d, id(c));
  const eliminati = await d.delete(argomento).where(eq(argomento.id_argomento, id(c))).returning({ id: argomento.id_argomento });
  if (!eliminati.length) return c.notFound();
  await eliminaOrfani(c.env, d, hash);
  return c.body(null, 204);
});

app.get("/argomenti/:id/carte", async (c) =>
  c.json(
    await db(c)
      .select()
      .from(carta)
      .innerJoin(ripasso, eq(ripasso.id_carta, carta.id_carta))
      .where(eq(carta.id_argomento, id(c)))
      .orderBy(carta.id_carta),
  ),
);

app.get("/carte/da-ripassare", async (c) => {
  return c.json(await carteDaRipassare(db(c), leggiFiltroRipasso(c.req.query())));
});

type Materiale = typeof materiale.$inferSelect;

// Nell'archivio un materiale porta solo metadati e hash (i byte restano in R2) e niente HTML, che si ricalcola all'import.
// `id` serve solo ai riferimenti delle spiegazioni dentro l'archivio.
const materialeArchivio = (m: Materiale) =>
  m.tipo === "testo"
    ? { id: m.id_materiale, tipo: m.tipo, titolo: m.titolo, testo: m.testo, creato_il: m.creato_il }
    : { id: m.id_materiale, tipo: m.tipo, titolo: m.titolo, hash: m.hash, mime: m.mime, dimensione: m.dimensione, creato_il: m.creato_il };

// Esportazione completa (versione 2): gli id vengono rigenerati all'importazione.
app.get("/esporta", async (c) => {
  const d = db(c);
  const [materie, argomenti, carte, tuttiMateriali, tutteSpiegazioni] = await Promise.all([
    d.select().from(materia),
    d.select().from(argomento),
    d.select({ carta, ripasso }).from(carta).innerJoin(ripasso, eq(ripasso.id_carta, carta.id_carta)),
    d.select().from(materiale).orderBy(materiale.id_materiale),
    d.select().from(spiegazione),
  ]);
  // Stessa regola di GET /carte/:id/spiegazione, in memoria: obsoleta se un materiale usato non c'è più o l'impronta è cambiata.
  // I riferimenti a materiali eliminati non entrano nell'archivio (non sarebbero importabili).
  const materialePerId = new Map(tuttiMateriali.map((m) => [m.id_materiale, m]));
  const cartaPerId = new Map(carte.map((r) => [r.carta.id_carta, r.carta]));
  const spiegazioniPerCarta = new Map(
    await Promise.all(
      tutteSpiegazioni
        .filter((s) => cartaPerId.has(s.id_carta))
        .map(async (s) => {
          const k = cartaPerId.get(s.id_carta)!;
          const usati = s.materiali
            .map((x) => materialePerId.get(x))
            .filter((m): m is Materiale => !!m && (m.id_carta === k.id_carta || m.id_argomento === k.id_argomento));
          const obsoleta = usati.length !== s.materiali.length || (await impronta(k, usati)) !== s.impronta;
          const voce = { testo: s.testo, fonte: s.fonte, modello: s.modello, materiali: usati.map((m) => m.id_materiale), obsoleta, creata_il: s.creata_il };
          return [s.id_carta, voce] as const;
        }),
    ),
  );
  const raggruppa = <T>(righe: T[], chiave: (r: T) => number) => {
    const gruppi = new Map<number, T[]>();
    for (const r of righe) {
      const k = chiave(r);
      const gruppo = gruppi.get(k);
      if (gruppo) gruppo.push(r);
      else gruppi.set(k, [r]);
    }
    return gruppi;
  };
  const perArgomento = raggruppa(carte, (r) => r.carta.id_argomento);
  const perMateria = raggruppa(argomenti, (a) => a.id_materia);
  const materialiArgomento = raggruppa(tuttiMateriali.filter((m) => m.id_argomento !== null), (m) => m.id_argomento!);
  const materialiCarta = raggruppa(tuttiMateriali.filter((m) => m.id_carta !== null), (m) => m.id_carta!);
  const archivio = {
    versione: 2,
    materie: materie.map((m) => ({
      nome_materia: m.nome_materia,
      argomenti: (perMateria.get(m.id_materia) ?? []).map((a) => ({
        nome_argomento: a.nome_argomento,
        materiali: (materialiArgomento.get(a.id_argomento) ?? []).map(materialeArchivio),
        carte: (perArgomento.get(a.id_argomento) ?? []).map(({ carta: k, ripasso: r }) => ({
          domanda: k.domanda,
          risposta: k.risposta,
          opzioni: k.opzioni,
          difficolta: k.difficolta,
          ripasso: {
            ultimo_ripasso: r.ultimo_ripasso,
            prossimo_ripasso: r.prossimo_ripasso,
            media_esito: r.media_esito,
            numero_ripassi: r.numero_ripassi,
          },
          materiali: (materialiCarta.get(k.id_carta) ?? []).map(materialeArchivio),
          spiegazione: spiegazioniPerCarta.get(k.id_carta) ?? null,
        })),
      })),
    })),
  };
  c.header("Content-Disposition", `attachment; filename="flashcard-${oggi()}.json"`);
  return c.json(archivio);
});

const blocchi = <T>(v: T[], n = 10) => Array.from({ length: Math.ceil(v.length / n) }, (_, i) => v.slice(i * n, (i + 1) * n));
const chiaveCarta = (idArgomento: number, domanda: string, risposta: string) => `${idArgomento}\u0000${domanda}\u0000${risposta}`;

type MaterialeImport = ReturnType<typeof leggiImportazione>["materie"][number]["argomenti"][number]["materiali"][number];
// Materiale reale (nuovo o già presente) a cui punta un id d'archivio: quanto serve per l'impronta delle spiegazioni.
type Riferimento = { id_materiale: number; testo: string | null; hash: string | null };

// Un materiale di un argomento è "lo stesso" se ha tipo, titolo e contenuto (testo o hash) uguali.
const chiaveMateriale = (idArgomento: number, m: { tipo: string; titolo: string | null; testo?: string | null; hash?: string | null }) =>
  [idArgomento, m.tipo, (m.titolo ?? "").trim(), m.tipo === "testo" ? m.testo : m.hash].join("\u0000");

// Unisce l'archivio a quello esistente: materie e argomenti con lo stesso nome si riusano, le carte già presenti
// (stesso argomento, domanda e risposta) si saltano con i loro materiali e la spiegazione, e i materiali già presenti
// in un argomento non si duplicano, quindi reimportare lo stesso file non crea nulla di nuovo.
// I file non sono nell'archivio: un materiale file si riaggancia solo se i suoi byte (chiave = hash) sono già in R2,
// altrimenti si salta e finisce in `file_mancanti`. Gli id dei materiali cambiano, quindi i riferimenti delle spiegazioni
// si rimappano e l'impronta si ricalcola; una spiegazione obsoleta, o che usava un file saltato, resta obsoleta.
// Gli id nuovi li assegna l'app e tutto entra in un solo batch D1 (una transazione): o entra tutto o niente.
// Con ?azzera=1 i ripassi ripartono da zero. I blocchi restano entro i 100 parametri per query di D1.
app.post("/importa", async (c) => {
  const { materie } = leggiImportazione(await c.req.json());
  const azzera = c.req.query("azzera") === "1";
  const d = db(c);

  // Gli id ripartono dal massimo tra il contatore AUTOINCREMENT e le righe presenti, per non riusare id già eliminati.
  const [[inizio], esistentiM, esistentiA, esistentiC, esistentiMt, hashNoti] = await Promise.all([
    d.all<{ m: number; a: number; c: number; mt: number }>(sql`SELECT
      max((SELECT coalesce(max(seq), 0) FROM sqlite_sequence WHERE name = 'materia'), (SELECT coalesce(max(id_materia), 0) FROM materia)) AS m,
      max((SELECT coalesce(max(seq), 0) FROM sqlite_sequence WHERE name = 'argomento'), (SELECT coalesce(max(id_argomento), 0) FROM argomento)) AS a,
      max((SELECT coalesce(max(seq), 0) FROM sqlite_sequence WHERE name = 'carta'), (SELECT coalesce(max(id_carta), 0) FROM carta)) AS c,
      max((SELECT coalesce(max(seq), 0) FROM sqlite_sequence WHERE name = 'materiale'), (SELECT coalesce(max(id_materiale), 0) FROM materiale)) AS mt`),
    d.select().from(materia),
    d.select().from(argomento),
    d.select({ id_argomento: carta.id_argomento, domanda: carta.domanda, risposta: carta.risposta }).from(carta),
    d
      .select({ id_materiale: materiale.id_materiale, tipo: materiale.tipo, titolo: materiale.titolo, testo: materiale.testo, hash: materiale.hash, id_argomento: materiale.id_argomento })
      .from(materiale)
      .where(isNotNull(materiale.id_argomento)),
    d.selectDistinct({ hash: materiale.hash }).from(materiale).where(isNotNull(materiale.hash)),
  ]);

  // Un file è in R2 di sicuro se un materiale lo usa (gli orfani vengono cancellati); gli altri hash si chiedono a R2.
  const filePresenti = new Set(hashNoti.map((r) => r.hash!));
  const hashIgnoti = new Set(
    materie
      .flatMap((m) => m.argomenti.flatMap((a) => [...a.materiali, ...a.carte.flatMap((k) => k.materiali)]))
      .flatMap((x) => (x.tipo === "file" && !filePresenti.has(x.hash) ? [x.hash] : [])),
  );
  for (const h of await Promise.all([...hashIgnoti].map(async (h) => ((await c.env.FILES.head(h)) ? h : null)))) if (h) filePresenti.add(h);

  let { m: idMateria, a: idArgomento, c: idCarta, mt: idMateriale } = inizio;
  const materiePerNome = new Map<string, number>();
  for (const m of esistentiM) if (!materiePerNome.has(m.nome_materia)) materiePerNome.set(m.nome_materia, m.id_materia);
  const argomentiPerNome = new Map<string, number>();
  for (const a of esistentiA) {
    const k = `${a.id_materia}\u0000${a.nome_argomento}`;
    if (!argomentiPerNome.has(k)) argomentiPerNome.set(k, a.id_argomento);
  }
  const cartePresenti = new Set(esistentiC.map((k) => chiaveCarta(k.id_argomento, k.domanda, k.risposta)));
  const materialiPresenti = new Map<string, Riferimento>();
  const fileArgomento = new Map<number, number>();
  for (const x of esistentiMt) {
    const k = chiaveMateriale(x.id_argomento!, x);
    if (!materialiPresenti.has(k)) materialiPresenti.set(k, x);
    if (x.tipo === "file") fileArgomento.set(x.id_argomento!, (fileArgomento.get(x.id_argomento!) ?? 0) + 1);
  }

  const nuoveMaterie: (typeof materia.$inferInsert)[] = [];
  const nuoviArgomenti: (typeof argomento.$inferInsert)[] = [];
  const nuoveCarte: (typeof carta.$inferInsert)[] = [];
  const nuoviRipassi: (typeof ripasso.$inferInsert)[] = [];
  const nuoviMateriali: (typeof materiale.$inferInsert)[] = [];
  const nuoveSpiegazioni: (typeof spiegazione.$inferInsert)[] = [];
  const fileMancanti: { argomento: string; carta: string | null; titolo: string | null; hash: string }[] = [];
  // id d'archivio → materiale reale; i file saltati non ci sono, così le spiegazioni che li usano risultano incomplete.
  const riferimenti = new Map<number, Riferimento>();
  let saltate = 0;

  const aggiungiMateriale = (x: MaterialeImport, proprietario: { id_argomento: number } | { id_carta: number }, nomeArgomento: string, domanda: string | null) => {
    if (x.tipo === "file" && !filePresenti.has(x.hash)) {
      fileMancanti.push({ argomento: nomeArgomento, carta: domanda, titolo: x.titolo, hash: x.hash });
      return;
    }
    const chiave = "id_argomento" in proprietario ? chiaveMateriale(proprietario.id_argomento, x) : null;
    const esistente = chiave === null ? undefined : materialiPresenti.get(chiave);
    if (esistente) {
      riferimenti.set(x.id, esistente);
      return;
    }
    if (x.tipo === "file" && "id_argomento" in proprietario) {
      const n = (fileArgomento.get(proprietario.id_argomento) ?? 0) + 1;
      if (n > MAX_FILE_PER_ARGOMENTO) throw new ErroreValidazione(`l'argomento "${nomeArgomento}" supererebbe il limite di ${MAX_FILE_PER_ARGOMENTO} file`);
      fileArgomento.set(proprietario.id_argomento, n);
    }
    const r: Riferimento = { id_materiale: ++idMateriale, testo: x.tipo === "testo" ? x.testo : null, hash: x.tipo === "file" ? x.hash : null };
    nuoviMateriali.push(
      x.tipo === "testo"
        ? { id_materiale: r.id_materiale, tipo: "testo", titolo: x.titolo, testo: x.testo, testo_render: rendi(x.testo), ...proprietario, creato_il: x.creato_il }
        : { id_materiale: r.id_materiale, tipo: "file", titolo: x.titolo, hash: x.hash, mime: x.mime, dimensione: x.dimensione, ...proprietario, creato_il: x.creato_il },
    );
    riferimenti.set(x.id, r);
    if (chiave !== null) materialiPresenti.set(chiave, r);
  };
  for (const m of materie) {
    let idM = materiePerNome.get(m.nome_materia);
    if (idM === undefined) {
      idM = ++idMateria;
      materiePerNome.set(m.nome_materia, idM);
      nuoveMaterie.push({ id_materia: idM, nome_materia: m.nome_materia });
    }
    for (const a of m.argomenti) {
      const chiaveArgomento = `${idM}\u0000${a.nome_argomento}`;
      let idA = argomentiPerNome.get(chiaveArgomento);
      if (idA === undefined) {
        idA = ++idArgomento;
        argomentiPerNome.set(chiaveArgomento, idA);
        nuoviArgomenti.push({ id_argomento: idA, nome_argomento: a.nome_argomento, id_materia: idM });
      }
      for (const x of a.materiali) aggiungiMateriale(x, { id_argomento: idA }, a.nome_argomento, null);
      for (const { ripasso: r, materiali: mk, spiegazione: s, ...k } of a.carte) {
        const chiave = chiaveCarta(idA, k.domanda, k.risposta);
        if (cartePresenti.has(chiave)) {
          saltate++;
          continue;
        }
        cartePresenti.add(chiave);
        const idK = ++idCarta;
        nuoveCarte.push({ ...k, domanda_render: rendi(k.domanda), risposta_render: rendi(k.risposta), id_carta: idK, id_argomento: idA });
        nuoviRipassi.push(azzera ? { id_carta: idK, prossimo_ripasso: oggi() } : { id_carta: idK, ...r });
        for (const x of mk) aggiungiMateriale(x, { id_carta: idK }, a.nome_argomento, k.domanda);
        if (!s) continue;
        // Un'impronta vuota non coincide mai con uno SHA-256: la spiegazione risulta obsoleta come prima dell'esportazione.
        // Due materiali d'archivio identici possono finire sullo stesso materiale già presente: gli id si deduplicano.
        const usati = [...new Map(s.materiali.flatMap((x) => riferimenti.get(x) ?? []).map((m) => [m.id_materiale, m])).values()];
        const valida = !s.obsoleta && s.materiali.every((x) => riferimenti.has(x));
        nuoveSpiegazioni.push({
          id_carta: idK,
          testo: s.testo,
          testo_render: rendi(s.testo),
          fonte: s.fonte,
          modello: s.modello,
          impronta: valida ? await impronta(k, usati) : "",
          materiali: usati.map((m) => m.id_materiale),
          creata_il: s.creata_il,
        });
      }
    }
  }

  // materiale ha 11 colonne: blocchi da 9 righe per restare sotto i 100 parametri.
  const istruzioni: BatchItem<"sqlite">[] = [
    ...blocchi(nuoveMaterie).map((b) => d.insert(materia).values(b)),
    ...blocchi(nuoviArgomenti).map((b) => d.insert(argomento).values(b)),
    ...blocchi(nuoveCarte).map((b) => d.insert(carta).values(b)),
    ...blocchi(nuoviRipassi).map((b) => d.insert(ripasso).values(b)),
    ...blocchi(nuoviMateriali, 9).map((b) => d.insert(materiale).values(b)),
    ...blocchi(nuoveSpiegazioni).map((b) => d.insert(spiegazione).values(b)),
  ];
  if (istruzioni.length) {
    try {
      await d.batch(istruzioni as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
    } catch (e) {
      // Qualcuno ha inserito nel frattempo con gli stessi id: nulla è stato scritto, basta riprovare.
      if (/UNIQUE|PRIMARY KEY/i.test(`${e} ${(e as Error).cause}`)) return c.json({ errore: "i dati sono cambiati durante l'importazione, riprova" }, 409);
      throw e;
    }
  }
  return c.json(
    {
      materie: nuoveMaterie.length,
      argomenti: nuoviArgomenti.length,
      carte: nuoveCarte.length,
      saltate,
      materiali: nuoviMateriali.length,
      spiegazioni: nuoveSpiegazioni.length,
      file_mancanti: fileMancanti,
    },
    201,
  );
});

app.get("/carte/:id", async (c) => {
  const [r] = await db(c)
    .select()
    .from(carta)
    .innerJoin(ripasso, eq(ripasso.id_carta, carta.id_carta))
    .where(eq(carta.id_carta, id(c)));
  return r ? c.json(r) : c.notFound();
});

// Carta e ripasso nella stessa batch (una transazione D1): o nascono entrambi o nessuno dei due.
app.post("/carte", async (c) => {
  const dati = leggiNuovaCarta(await c.req.json());
  const d = db(c);
  const [a] = await d.select({ id: argomento.id_argomento }).from(argomento).where(eq(argomento.id_argomento, dati.id_argomento));
  if (!a) return inesistente("argomento");
  const [[k], [r]] = await d.batch([
    d.insert(carta).values({ ...dati, domanda_render: rendi(dati.domanda), risposta_render: rendi(dati.risposta) }).returning(),
    d.insert(ripasso).values({ id_carta: sql`last_insert_rowid()`, prossimo_ripasso: oggi() }).returning(),
  ]);
  return c.json({ carta: k, ripasso: r }, 201);
});

app.put("/carte/:id", async (c) => {
  const dati = leggiModificaCarta(await c.req.json());
  // Il render si ricalcola solo per i testi che cambiano.
  const render = {
    domanda_render: dati.domanda === undefined ? undefined : rendi(dati.domanda),
    risposta_render: dati.risposta === undefined ? undefined : rendi(dati.risposta),
  };
  const [k] = await db(c).update(carta).set({ ...dati, ...render }).where(eq(carta.id_carta, id(c))).returning();
  return k ? c.json(k) : c.notFound();
});

app.delete("/carte/:id", async (c) => {
  const d = db(c);
  const hash = await hashCarta(d, id(c));
  const eliminate = await d.delete(carta).where(eq(carta.id_carta, id(c))).returning({ id: carta.id_carta });
  if (!eliminate.length) return c.notFound();
  await eliminaOrfani(c.env, d, hash);
  return c.body(null, 204);
});

// Una tantum, per i dati precedenti al LaTeX: a ogni chiamata rende fino a 100 carte e note ancora senza HTML e dice
// quante ne restano. Si ripete finché `rimaste` è 0. Fino ad allora il frontend mostra il testo grezzo.
const LOTTO_RENDER = 100;
app.post("/rirenderizza", async (c) => {
  const d = db(c);
  const cartaDaFare = or(isNull(carta.domanda_render), isNull(carta.risposta_render));
  const notaDaFare = and(eq(materiale.tipo, "testo"), isNull(materiale.testo_render));
  const carte = await d
    .select({ id: carta.id_carta, domanda: carta.domanda, risposta: carta.risposta })
    .from(carta)
    .where(cartaDaFare)
    .limit(LOTTO_RENDER);
  const note = await d
    .select({ id: materiale.id_materiale, testo: materiale.testo })
    .from(materiale)
    .where(notaDaFare)
    .limit(LOTTO_RENDER - carte.length);
  const istruzioni: BatchItem<"sqlite">[] = [
    ...carte.map((k) => d.update(carta).set({ domanda_render: rendi(k.domanda), risposta_render: rendi(k.risposta) }).where(eq(carta.id_carta, k.id))),
    ...note.map((n) => d.update(materiale).set({ testo_render: rendi(n.testo ?? "") }).where(eq(materiale.id_materiale, n.id))),
  ];
  if (istruzioni.length) await d.batch(istruzioni as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  const [{ n: rimasteCarte }] = await d.select({ n: sql<number>`count(*)` }).from(carta).where(cartaDaFare);
  const [{ n: rimasteNote }] = await d.select({ n: sql<number>`count(*)` }).from(materiale).where(notaDaFare);
  return c.json({ rinnovate: istruzioni.length, rimaste: rimasteCarte + rimasteNote });
});

app.post("/carte/:id/voto", async (c) => {
  const voto = leggiVoto(await c.req.json());
  const [k] = await db(c)
    .select({ ripasso, difficolta: carta.difficolta })
    .from(ripasso)
    .innerJoin(carta, eq(carta.id_carta, ripasso.id_carta))
    .where(eq(ripasso.id_carta, id(c)));
  if (!k) return c.notFound();
  const nuovo = await registraVoto(db(c), k.ripasso, voto, k.difficolta);
  return nuovo ? c.json(nuovo) : c.json({ errore: "la carta è stata ripassata nel frattempo, riprova" }, 409);
});

// Unica rotta esclusa da Cloudflare Access: la protegge il secret che Telegram invia in ogni richiesta.
// Risponde sempre 200 alle richieste autentiche, altrimenti Telegram le ripeterebbe all'infinito.
app.post("/telegram/webhook", async (c) => {
  if (!(await segretoValido(c.req.header("X-Telegram-Bot-Api-Secret-Token"), c.env.TELEGRAM_WEBHOOK_SECRET)))
    return c.body(null, 401);
  try {
    await gestisciUpdate(c.env, await c.req.json());
  } catch (e) {
    console.error(e);
  }
  return c.body(null, 200);
});

export default {
  fetch: app.fetch,
  scheduled: (_evento, env, ctx) => ctx.waitUntil(invioProgrammato(env)),
} satisfies ExportedHandler<Env>;
