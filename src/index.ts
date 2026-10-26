import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, getTableColumns, sql } from "drizzle-orm";
import { materia, argomento, carta, ripasso } from "./schema";
import { carteDaRipassare, oggi, registraVoto } from "./ripasso";
import { gestisciUpdate, invioProgrammato, segretoValido, type Env } from "./telegram";

const app = new Hono<{ Bindings: Env }>();
const db = (c: { env: { DB: D1Database } }) => drizzle(c.env.DB);

app.onError((e, c) => c.json({ errore: e.message }, 400));

app.get("/materie", async (c) => c.json(await db(c).select().from(materia)));

app.get("/materie/:id", async (c) => {
  const [m] = await db(c).select().from(materia).where(eq(materia.id_materia, +c.req.param("id")));
  return m ? c.json(m) : c.notFound();
});

app.post("/materie", async (c) => {
  const [m] = await db(c).insert(materia).values(await c.req.json()).returning();
  return c.json(m, 201);
});

app.put("/materie/:id", async (c) => {
  const [m] = await db(c).update(materia).set(await c.req.json()).where(eq(materia.id_materia, +c.req.param("id"))).returning();
  return m ? c.json(m) : c.notFound();
});

app.delete("/materie/:id", async (c) => {
  await db(c).delete(materia).where(eq(materia.id_materia, +c.req.param("id")));
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
      .where(eq(argomento.id_materia, +c.req.param("id")))
      .groupBy(argomento.id_argomento),
  ),
);

app.get("/materie/:id/carte", async (c) =>
  c.json(
    await db(c)
      .select({ ...getTableColumns(carta), nome_argomento: argomento.nome_argomento })
      .from(carta)
      .innerJoin(argomento, eq(argomento.id_argomento, carta.id_argomento))
      .where(eq(argomento.id_materia, +c.req.param("id"))),
  ),
);

app.get("/argomenti/:id", async (c) => {
  const [a] = await db(c).select().from(argomento).where(eq(argomento.id_argomento, +c.req.param("id")));
  return a ? c.json(a) : c.notFound();
});

app.post("/argomenti", async (c) => {
  const [a] = await db(c).insert(argomento).values(await c.req.json()).returning();
  return c.json(a, 201);
});

app.put("/argomenti/:id", async (c) => {
  const [a] = await db(c).update(argomento).set(await c.req.json()).where(eq(argomento.id_argomento, +c.req.param("id"))).returning();
  return a ? c.json(a) : c.notFound();
});

app.delete("/argomenti/:id", async (c) => {
  await db(c).delete(argomento).where(eq(argomento.id_argomento, +c.req.param("id")));
  return c.body(null, 204);
});

app.get("/argomenti/:id/carte", async (c) =>
  c.json(
    await db(c)
      .select()
      .from(carta)
      .innerJoin(ripasso, eq(ripasso.id_carta, carta.id_carta))
      .where(eq(carta.id_argomento, +c.req.param("id"))),
  ),
);

app.get("/carte/da-ripassare", async (c) => {
  const { materia: idMateria, argomenti } = c.req.query();
  return c.json(
    await carteDaRipassare(db(c), idMateria ? +idMateria : undefined, argomenti ? argomenti.split(",").map(Number) : undefined),
  );
});

app.get("/carte/:id", async (c) => {
  const [r] = await db(c)
    .select()
    .from(carta)
    .innerJoin(ripasso, eq(ripasso.id_carta, carta.id_carta))
    .where(eq(carta.id_carta, +c.req.param("id")));
  return r ? c.json(r) : c.notFound();
});

app.post("/carte", async (c) => {
  // Difficoltà 3 (neutra) se non indicata: il default della colonna nel DB è ancora 1.
  const [k] = await db(c).insert(carta).values({ difficolta: 3, ...(await c.req.json()) }).returning();
  const [r] = await db(c).insert(ripasso).values({ id_carta: k.id_carta, prossimo_ripasso: oggi() }).returning();
  return c.json({ carta: k, ripasso: r }, 201);
});

app.put("/carte/:id", async (c) => {
  const [k] = await db(c).update(carta).set(await c.req.json()).where(eq(carta.id_carta, +c.req.param("id"))).returning();
  return k ? c.json(k) : c.notFound();
});

app.delete("/carte/:id", async (c) => {
  await db(c).delete(carta).where(eq(carta.id_carta, +c.req.param("id")));
  return c.body(null, 204);
});

app.post("/carte/:id/voto", async (c) => {
  const { voto } = await c.req.json();
  if (!Number.isInteger(voto) || voto < 0 || voto > 5) return c.json({ errore: "voto deve essere un intero da 0 a 5" }, 400);
  const [k] = await db(c)
    .select({ ripasso, difficolta: carta.difficolta })
    .from(ripasso)
    .innerJoin(carta, eq(carta.id_carta, ripasso.id_carta))
    .where(eq(ripasso.id_carta, +c.req.param("id")));
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
