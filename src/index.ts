import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle } from "drizzle-orm/d1";
import { eq, getTableColumns, sql } from "drizzle-orm";
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

app.get("/materie", async (c) => c.json(await db(c).select().from(materia)));

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
  await db(c).delete(materia).where(eq(materia.id_materia, id(c)));
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
      .groupBy(argomento.id_argomento),
  ),
);

app.get("/materie/:id/carte", async (c) =>
  c.json(
    await db(c)
      .select({ ...getTableColumns(carta), nome_argomento: argomento.nome_argomento })
      .from(carta)
      .innerJoin(argomento, eq(argomento.id_argomento, carta.id_argomento))
      .where(eq(argomento.id_materia, id(c))),
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
  await db(c).delete(argomento).where(eq(argomento.id_argomento, id(c)));
  return c.body(null, 204);
});

app.get("/argomenti/:id/carte", async (c) =>
  c.json(
    await db(c)
      .select()
      .from(carta)
      .innerJoin(ripasso, eq(ripasso.id_carta, carta.id_carta))
      .where(eq(carta.id_argomento, id(c))),
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
    for (const r of righe) gruppi.set(chiave(r), (gruppi.get(chiave(r)) ?? []).concat([r]));
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

// Aggiunge sempre nuovi record, senza toccare quelli esistenti. Con ?azzera=1 i ripassi ripartono da zero.
// Le carte entrano a blocchi (D1 limita i parametri per query): un errore a metà lascia l'importazione parziale.
app.post("/importa", async (c) => {
  const { materie } = leggiImportazione(await c.req.json());
  const azzera = c.req.query("azzera") === "1";
  const d = db(c);
  const conteggi = { materie: 0, argomenti: 0, carte: 0 };
  for (const m of materie) {
    const [nuova] = await d.insert(materia).values({ nome_materia: m.nome_materia }).returning();
    conteggi.materie++;
    for (const a of m.argomenti) {
      const [nuovo] = await d.insert(argomento).values({ nome_argomento: a.nome_argomento, id_materia: nuova.id_materia }).returning();
      conteggi.argomenti++;
      for (let i = 0; i < a.carte.length; i += 10) {
        const blocco = a.carte.slice(i, i + 10);
        const inserite = await d
          .insert(carta)
          .values(blocco.map(({ ripasso: _, ...k }) => ({ ...k, id_argomento: nuovo.id_argomento })))
          .returning({ id_carta: carta.id_carta });
                await d.insert(ripasso).values(
          inserite.map(({ id_carta }, j) =>
            azzera ? { id_carta, prossimo_ripasso: oggi() } : { id_carta, ...blocco[j].ripasso },
          ),
        );
        conteggi.carte += inserite.length;
      }
    }
  }
  return c.json(conteggi, 201);
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
  await db(c).delete(carta).where(eq(carta.id_carta, id(c)));
  return c.body(null, 204);
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
