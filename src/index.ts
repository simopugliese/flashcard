import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle } from "drizzle-orm/d1";
import { eq, getTableColumns, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { materia, argomento, carta, ripasso } from "./schema";
import { carteDaRipassare, oggi, registraVoto } from "./ripasso";
import { gestisciUpdate, invioProgrammato, segretoValido, type Env } from "./telegram";
import {
  ErroreValidazione,
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
  console.error(e);
  return c.json({ errore: "errore interno" }, 500);
});

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

app.delete("/materie/:id", async (c) => {
  const eliminate = await db(c).delete(materia).where(eq(materia.id_materia, id(c))).returning({ id: materia.id_materia });
  return eliminate.length ? c.body(null, 204) : c.notFound();
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
  const eliminati = await db(c).delete(argomento).where(eq(argomento.id_argomento, id(c))).returning({ id: argomento.id_argomento });
  return eliminati.length ? c.body(null, 204) : c.notFound();
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

// Esportazione completa (senza id, che vengono rigenerati all'importazione).
app.get("/esporta", async (c) => {
  const d = db(c);
  const [materie, argomenti, carte] = await Promise.all([
    d.select().from(materia),
    d.select().from(argomento),
    d.select({ carta, ripasso }).from(carta).innerJoin(ripasso, eq(ripasso.id_carta, carta.id_carta)),
  ]);
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
  const archivio = {
    versione: 1,
    materie: materie.map((m) => ({
      nome_materia: m.nome_materia,
      argomenti: (perMateria.get(m.id_materia) ?? []).map((a) => ({
        nome_argomento: a.nome_argomento,
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
        })),
      })),
    })),
  };
  c.header("Content-Disposition", `attachment; filename="flashcard-${oggi()}.json"`);
  return c.json(archivio);
});

const blocchi = <T>(v: T[], n = 10) => Array.from({ length: Math.ceil(v.length / n) }, (_, i) => v.slice(i * n, (i + 1) * n));
const chiaveCarta = (idArgomento: number, domanda: string, risposta: string) => `${idArgomento}\u0000${domanda}\u0000${risposta}`;

// Unisce l'archivio a quello esistente: materie e argomenti con lo stesso nome si riusano, le carte già presenti
// (stesso argomento, domanda e risposta) si saltano, quindi reimportare lo stesso file non crea nulla di nuovo.
// Gli id nuovi li assegna l'app e tutto entra in un solo batch D1 (una transazione): o entra tutto o niente.
// Con ?azzera=1 i ripassi ripartono da zero. I blocchi da 10 righe restano entro i 100 parametri per query di D1.
app.post("/importa", async (c) => {
  const { materie } = leggiImportazione(await c.req.json());
  const azzera = c.req.query("azzera") === "1";
  const d = db(c);

  // Gli id ripartono dal massimo tra il contatore AUTOINCREMENT e le righe presenti, per non riusare id già eliminati.
  const ultimo = (tabella: string, colonna: string) =>
    `max((SELECT coalesce(max(seq), 0) FROM sqlite_sequence WHERE name = '${tabella}'), (SELECT coalesce(max(${colonna}), 0) FROM ${tabella}))`;
  const [[inizio], esistentiM, esistentiA, esistentiC] = await Promise.all([
    d.all<{ m: number; a: number; c: number }>(
      sql.raw(`SELECT ${ultimo("materia", "id_materia")} AS m, ${ultimo("argomento", "id_argomento")} AS a, ${ultimo("carta", "id_carta")} AS c`),
    ),
    d.select().from(materia),
    d.select().from(argomento),
    d.select({ id_argomento: carta.id_argomento, domanda: carta.domanda, risposta: carta.risposta }).from(carta),
  ]);

  let { m: idMateria, a: idArgomento, c: idCarta } = inizio;
  const materiePerNome = new Map<string, number>();
  for (const m of esistentiM) if (!materiePerNome.has(m.nome_materia)) materiePerNome.set(m.nome_materia, m.id_materia);
  const argomentiPerNome = new Map<string, number>();
  for (const a of esistentiA) {
    const k = `${a.id_materia}\u0000${a.nome_argomento}`;
    if (!argomentiPerNome.has(k)) argomentiPerNome.set(k, a.id_argomento);
  }
  const cartePresenti = new Set(esistentiC.map((k) => chiaveCarta(k.id_argomento, k.domanda, k.risposta)));

  const nuoveMaterie: (typeof materia.$inferInsert)[] = [];
  const nuoviArgomenti: (typeof argomento.$inferInsert)[] = [];
  const nuoveCarte: (typeof carta.$inferInsert)[] = [];
  const nuoviRipassi: (typeof ripasso.$inferInsert)[] = [];
  let saltate = 0;
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
      for (const { ripasso: r, ...k } of a.carte) {
        const chiave = chiaveCarta(idA, k.domanda, k.risposta);
        if (cartePresenti.has(chiave)) {
          saltate++;
          continue;
        }
        cartePresenti.add(chiave);
        const idK = ++idCarta;
        nuoveCarte.push({ ...k, id_carta: idK, id_argomento: idA });
        nuoviRipassi.push(azzera ? { id_carta: idK, prossimo_ripasso: oggi() } : { id_carta: idK, ...r });
      }
    }
  }

  const istruzioni: BatchItem<"sqlite">[] = [
    ...blocchi(nuoveMaterie).map((b) => d.insert(materia).values(b)),
    ...blocchi(nuoviArgomenti).map((b) => d.insert(argomento).values(b)),
    ...blocchi(nuoveCarte).map((b) => d.insert(carta).values(b)),
    ...blocchi(nuoviRipassi).map((b) => d.insert(ripasso).values(b)),
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
  return c.json({ materie: nuoveMaterie.length, argomenti: nuoviArgomenti.length, carte: nuoveCarte.length, saltate }, 201);
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
    d.insert(carta).values(dati).returning(),
    d.insert(ripasso).values({ id_carta: sql`last_insert_rowid()`, prossimo_ripasso: oggi() }).returning(),
  ]);
  return c.json({ carta: k, ripasso: r }, 201);
});

app.put("/carte/:id", async (c) => {
  const [k] = await db(c).update(carta).set(leggiModificaCarta(await c.req.json())).where(eq(carta.id_carta, id(c))).returning();
  return k ? c.json(k) : c.notFound();
});

app.delete("/carte/:id", async (c) => {
  const eliminate = await db(c).delete(carta).where(eq(carta.id_carta, id(c))).returning({ id: carta.id_carta });
  return eliminate.length ? c.body(null, 204) : c.notFound();
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
