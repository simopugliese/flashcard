import { Hono, type Context } from "hono";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, count, eq, inArray, isNotNull, or } from "drizzle-orm";
import { argomento, carta, materiale } from "./schema";
import type { Env } from "./telegram";
import {
  controllaFile,
  ErroreValidazione,
  idPercorso,
  leggiModificaMateriale,
  leggiNuovaNota,
  MAX_FILE_BYTES,
  MAX_FILE_PER_ARGOMENTO,
  MAX_FILE_PER_CARTA,
} from "./validazione";

type Proprietario = { id_argomento: number } | { id_carta: number };

const sha256 = async (byte: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", byte))].map((b) => b.toString(16).padStart(2, "0")).join("");

// Hash dei file di un gruppo di materiali: da leggere PRIMA di eliminare argomento/carta/materia (le righe spariscono a cascata)
// e da passare a `eliminaOrfani` dopo.
const hashDove = async (d: DrizzleD1Database, dove: ReturnType<typeof eq>) =>
  (await d.selectDistinct({ hash: materiale.hash }).from(materiale).where(and(isNotNull(materiale.hash), dove))).map((r) => r.hash!);

export const hashCarta = (d: DrizzleD1Database, idCarta: number) => hashDove(d, eq(materiale.id_carta, idCarta));

export const hashArgomento = (d: DrizzleD1Database, idArgomento: number) =>
  hashDove(
    d,
    or(
      eq(materiale.id_argomento, idArgomento),
      inArray(materiale.id_carta, d.select({ id: carta.id_carta }).from(carta).where(eq(carta.id_argomento, idArgomento))),
    )!,
  );

export const hashMateria = (d: DrizzleD1Database, idMateria: number) => {
  const argomenti = d.select({ id: argomento.id_argomento }).from(argomento).where(eq(argomento.id_materia, idMateria));
  return hashDove(
    d,
    or(
      inArray(materiale.id_argomento, argomenti),
      inArray(materiale.id_carta, d.select({ id: carta.id_carta }).from(carta).where(inArray(carta.id_argomento, argomenti))),
    )!,
  );
};

// Toglie da R2 i file che nessun materiale referenzia più. Se nel frattempo qualcuno carica lo stesso contenuto la finestra di
// gara è di pochi millisecondi: per un'app a utente singolo il caso peggiore è un materiale da ricaricare.
export const eliminaOrfani = async (env: Env, d: DrizzleD1Database, hash: string[]) => {
  for (const h of new Set(hash)) {
    const [{ n }] = await d.select({ n: count() }).from(materiale).where(eq(materiale.hash, h));
    if (!n) await env.FILES.delete(h);
  }
};

const proprietarioEsiste = async (d: DrizzleD1Database, p: Proprietario) => {
  const [r] =
    "id_carta" in p
      ? await d.select({ id: carta.id_carta }).from(carta).where(eq(carta.id_carta, p.id_carta))
      : await d.select({ id: argomento.id_argomento }).from(argomento).where(eq(argomento.id_argomento, p.id_argomento));
  return !!r;
};

const dove = (p: Proprietario) => ("id_carta" in p ? eq(materiale.id_carta, p.id_carta) : eq(materiale.id_argomento, p.id_argomento));

const router = new Hono<{ Bindings: Env }>();
const db = (c: { env: { DB: D1Database } }) => drizzle(c.env.DB);
const id = (c: { req: { param: (nome: "id") => string | undefined } }) => idPercorso(c.req.param("id"));

const elenca = (p: Proprietario) => async (c: Context<{ Bindings: Env }>) => {
  const d = db(c);
  if (!(await proprietarioEsiste(d, p))) return c.notFound();
  return c.json(await d.select().from(materiale).where(dove(p)).orderBy(materiale.id_materiale));
};

// Con Content-Type multipart/form-data (campo `file`, `titolo` facoltativo) si carica un file, altrimenti il corpo è una nota JSON.
const crea = async (c: Context<{ Bindings: Env }>, p: Proprietario) => {
  const d = db(c);
  if (!(await proprietarioEsiste(d, p))) return c.notFound();
  const ora = Date.now();
  const proprietario = "id_carta" in p ? { id_carta: p.id_carta } : { id_argomento: p.id_argomento };

  if (!c.req.header("Content-Type")?.startsWith("multipart/form-data")) {
    const [m] = await d.insert(materiale).values({ tipo: "testo", ...leggiNuovaNota(await c.req.json()), ...proprietario, creato_il: ora }).returning();
    return c.json(m, 201);
  }

  // Rifiuto subito i corpi enormi, senza leggerli (64 KB di margine per l'involucro multipart).
  if (Number(c.req.header("Content-Length") ?? 0) > MAX_FILE_BYTES + 64 * 1024)
    return c.json({ errore: `il file supera il limite di ${MAX_FILE_BYTES / 1024 / 1024} MB` }, 413);
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new ErroreValidazione("manca il campo file");
  const byte = new Uint8Array(await file.arrayBuffer());
  const mime = controllaFile(file.type, byte);

  const [{ n }] = await d.select({ n: count() }).from(materiale).where(and(dove(p), eq(materiale.tipo, "file")));
  const massimo = "id_carta" in p ? MAX_FILE_PER_CARTA : MAX_FILE_PER_ARGOMENTO;
  if (n >= massimo) throw new ErroreValidazione(`al massimo ${massimo} file per ${"id_carta" in p ? "carta" : "argomento"}`);

  const hash = await sha256(byte);
  if (!(await c.env.FILES.head(hash))) await c.env.FILES.put(hash, byte, { httpMetadata: { contentType: mime } });
  const titolo = form.get("titolo");
  const [m] = await d
    .insert(materiale)
    .values({
      tipo: "file",
      titolo: typeof titolo === "string" && titolo.trim() ? titolo.trim().slice(0, 100) : file.name.slice(0, 100) || null,
      hash,
      mime,
      dimensione: byte.length,
      ...proprietario,
      creato_il: ora,
    })
    .returning();
  return c.json(m, 201);
};

router.get("/argomenti/:id/materiali", (c) => elenca({ id_argomento: id(c) })(c));
router.get("/carte/:id/materiali", (c) => elenca({ id_carta: id(c) })(c));
router.post("/argomenti/:id/materiali", (c) => crea(c, { id_argomento: id(c) }));
router.post("/carte/:id/materiali", (c) => crea(c, { id_carta: id(c) }));

router.put("/materiali/:id", async (c) => {
  const d = db(c);
  const dati = leggiModificaMateriale(await c.req.json());
  const [m] = await d.select({ tipo: materiale.tipo }).from(materiale).where(eq(materiale.id_materiale, id(c)));
  if (!m) return c.notFound();
  if (m.tipo === "file" && dati.testo !== undefined) throw new ErroreValidazione("il testo si può modificare solo nelle note");
  const [r] = await d.update(materiale).set(dati).where(eq(materiale.id_materiale, id(c))).returning();
  return c.json(r);
});

router.delete("/materiali/:id", async (c) => {
  const d = db(c);
  const [m] = await d.delete(materiale).where(eq(materiale.id_materiale, id(c))).returning({ hash: materiale.hash });
  if (!m) return c.notFound();
  if (m.hash) await eliminaOrfani(c.env, d, [m.hash]);
  return c.body(null, 204);
});

// L'hash è il contenuto stesso, quindi la risposta non cambia mai e si può tenere in cache a lungo.
router.get("/materiali/:id/file", async (c) => {
  const [m] = await db(c).select().from(materiale).where(and(eq(materiale.id_materiale, id(c)), eq(materiale.tipo, "file")));
  if (!m?.hash || !m.mime) return c.notFound();
  const oggetto = await c.env.FILES.get(m.hash);
  if (!oggetto) return c.notFound();
  const immagine = m.mime.startsWith("image/");
  return new Response(oggetto.body, {
    headers: {
      "Content-Type": m.mime,
      "Content-Length": String(m.dimensione ?? oggetto.size),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": `${immagine ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(m.titolo ?? "file")}`,
    },
  });
});

export default router;
