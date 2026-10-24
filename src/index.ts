import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray, lte } from "drizzle-orm";
import { materia, argomento, carta, ripasso } from "./schema";

const app = new Hono<{ Bindings: { DB: D1Database } }>();
const db = (c: { env: { DB: D1Database } }) => drizzle(c.env.DB);
const oggi = (giorni = 0) => new Date(Date.now() + giorni * 86400000).toISOString().slice(0, 10);

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

app.get("/materie/:id/argomenti", async (c) =>
  c.json(await db(c).select().from(argomento).where(eq(argomento.id_materia, +c.req.param("id")))),
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
    await db(c)
      .select({ carta, ripasso })
      .from(carta)
      .innerJoin(ripasso, eq(ripasso.id_carta, carta.id_carta))
      .innerJoin(argomento, eq(argomento.id_argomento, carta.id_argomento))
      .where(
        and(
          lte(ripasso.prossimo_ripasso, oggi()),
          idMateria ? eq(argomento.id_materia, +idMateria) : undefined,
          argomenti ? inArray(carta.id_argomento, argomenti.split(",").map(Number)) : undefined,
        ),
      )
      .orderBy(ripasso.prossimo_ripasso, ripasso.media_esito),
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
  const [k] = await db(c).insert(carta).values(await c.req.json()).returning();
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
  const id = +c.req.param("id");
  const { voto } = await c.req.json();
  if (!Number.isInteger(voto) || voto < 0 || voto > 5) return c.json({ errore: "voto deve essere un intero da 0 a 5" }, 400);
  const [r] = await db(c).select().from(ripasso).where(eq(ripasso.id_carta, id));
  if (!r) return c.notFound();
  const n = r.numero_ripassi + 1;
  const media = (r.media_esito * r.numero_ripassi + voto) / n;
  const giorni = voto < 3 ? 1 : Math.ceil(media * n);
  const [nuovo] = await db(c)
    .update(ripasso)
    .set({ ultimo_ripasso: oggi(), prossimo_ripasso: oggi(giorni), media_esito: media, numero_ripassi: n })
    .where(eq(ripasso.id_carta, id))
    .returning();
  return c.json(nuovo);
});

export default app;
