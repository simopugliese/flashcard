import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { carta, materiale, spiegazione, uso_ai } from "./schema";
import { rendi } from "./render";
import { oggi } from "./ripasso";
import type { Env } from "./telegram";
import {
  base64,
  costruisciPrompt,
  impronta,
  MAX_BYTE_AI,
  MAX_CHIAMATE_AI_GIORNO,
  MAX_IMMAGINI_AI,
  ottieni,
  promptTestuale,
  providerDa,
  type MaterialeAI,
} from "./ai";
import { ErroreValidazione, idPercorso, leggiRichiestaGenera, leggiRichiestaPrompt, leggiSpiegazioneManuale } from "./validazione";

type Carta = { id_carta: number; domanda: string; risposta: string; opzioni: string[] | null; id_argomento: number };
type Materiale = typeof materiale.$inferSelect;
type Spiegazione = typeof spiegazione.$inferSelect;

const router = new Hono<{ Bindings: Env }>();
const db = (c: { env: { DB: D1Database } }) => drizzle(c.env.DB);
const id = (c: { req: { param: (nome: "id") => string | undefined } }) => idPercorso(c.req.param("id"));

// Risposta con un codice e un messaggio, lanciata da dentro le funzioni (la gestisce app.onError).
const interrompi = (c: Context, stato: 429 | 503, errore: string): never => {
  throw new HTTPException(stato, { res: c.json({ errore }, stato) });
};

const leggiCarta = async (d: DrizzleD1Database, idCarta: number): Promise<Carta | undefined> => {
  const [k] = await d
    .select({ id_carta: carta.id_carta, domanda: carta.domanda, risposta: carta.risposta, opzioni: carta.opzioni, id_argomento: carta.id_argomento })
    .from(carta)
    .where(eq(carta.id_carta, idCarta));
  return k;
};

// Materiali tra `ids` che appartengono alla carta o al suo argomento, in ordine di id.
const materialiDi = async (d: DrizzleD1Database, k: Carta, ids: number[]) =>
  ids.length
    ? d
        .select()
        .from(materiale)
        .where(and(inArray(materiale.id_materiale, ids), or(eq(materiale.id_carta, k.id_carta), eq(materiale.id_argomento, k.id_argomento))))
        .orderBy(materiale.id_materiale)
    : [];

const materialiRichiesti = async (d: DrizzleD1Database, k: Carta, ids: number[]) => {
  const righe = await materialiDi(d, k, ids);
  if (righe.length !== ids.length) throw new ErroreValidazione("alcuni materiali non esistono o non appartengono alla carta o al suo argomento");
  return righe;
};

const leggiFile = async (env: Env, m: Materiale) => {
  const oggetto = await env.FILES.get(m.hash!);
  if (!oggetto) throw new ErroreValidazione(`il file del materiale ${m.id_materiale} non è più disponibile`);
  return oggetto;
};

// Note e file di testo diventano testo; immagini e PDF base64 solo se `binari` (altrimenti restano un segnaposto).
const prepara = (env: Env, righe: Materiale[], binari: boolean) =>
  Promise.all(
    righe.map(async (m): Promise<MaterialeAI> => {
      const base = { id_materiale: m.id_materiale, titolo: m.titolo, mime: m.mime };
      if (m.tipo === "testo") return { ...base, testo: m.testo ?? "" };
      if (m.mime === "text/plain") return { ...base, testo: await (await leggiFile(env, m)).text() };
      return binari ? { ...base, base64: base64(new Uint8Array(await (await leggiFile(env, m)).arrayBuffer())) } : base;
    }),
  );

// Una spiegazione è obsoleta se la carta o uno dei materiali usati è cambiato, o se un materiale è stato eliminato.
const obsoleta = async (d: DrizzleD1Database, k: Carta, s: Spiegazione) => {
  const righe = await materialiDi(d, k, s.materiali);
  return righe.length !== s.materiali.length || (await impronta(k, righe)) !== s.impronta;
};

const stato = (env: Env, s: Spiegazione | null, vecchia = false) => ({ spiegazione: s, obsoleta: vecchia, ai: providerDa(env) !== null });

const salva = async (d: DrizzleD1Database, valori: Spiegazione) => {
  const { id_carta: _, ...campi } = valori;
  const [s] = await d.insert(spiegazione).values(valori).onConflictDoUpdate({ target: spiegazione.id_carta, set: campi }).returning();
  return s;
};

// Prenota una chiamata nel contatore del giorno; false se il tetto è già raggiunto. Una sola istruzione, quindi atomica.
const prenotaChiamata = async (d: DrizzleD1Database) =>
  (
    await d
      .insert(uso_ai)
      .values({ giorno: oggi(), chiamate: 1 })
      .onConflictDoUpdate({ target: uso_ai.giorno, set: { chiamate: sql`${uso_ai.chiamate} + 1` }, setWhere: sql`${uso_ai.chiamate} < ${MAX_CHIAMATE_AI_GIORNO}` })
      .returning({ n: uso_ai.chiamate })
  ).length > 0;

router.get("/carte/:id/spiegazione", async (c) => {
  const d = db(c);
  const k = await leggiCarta(d, id(c));
  if (!k) return c.notFound();
  const [s] = await d.select().from(spiegazione).where(eq(spiegazione.id_carta, k.id_carta));
  return c.json(stato(c.env, s ?? null, s ? await obsoleta(d, k, s) : false));
});

// Spiegazione scritta a mano (o incollata da una chat esterna): sostituisce sempre quella salvata.
router.put("/carte/:id/spiegazione", async (c) => {
  const dati = leggiSpiegazioneManuale(await c.req.json());
  const d = db(c);
  const k = await leggiCarta(d, id(c));
  if (!k) return c.notFound();
  const righe = await materialiRichiesti(d, k, dati.materiali);
  const s = await salva(d, {
    id_carta: k.id_carta,
    testo: dati.testo,
    testo_render: rendi(dati.testo),
    fonte: "manuale",
    modello: null,
    impronta: await impronta(k, righe),
    materiali: righe.map((m) => m.id_materiale),
    creata_il: Date.now(),
  });
  return c.json(stato(c.env, s));
});

// Se la spiegazione esiste (anche manuale) la restituisce senza chiamare l'AI, a meno di `rigenera: true`.
router.post("/carte/:id/spiegazione/genera", async (c) => {
  const richiesta = leggiRichiestaGenera(await c.req.json());
  const d = db(c);
  const k = await leggiCarta(d, id(c));
  if (!k) return c.notFound();
  const [esistente] = await d.select().from(spiegazione).where(eq(spiegazione.id_carta, k.id_carta));

  const { valore, dalla_cache } = await ottieni(esistente, richiesta.rigenera, async () => {
    const provider = providerDa(c.env) ?? interrompi(c, 503, "la funzione AI non è configurata: scrivi la spiegazione a mano");
    const righe = await materialiRichiesti(d, k, richiesta.materiali);
    if (!provider.pdf && righe.some((m) => m.mime === "application/pdf")) throw new ErroreValidazione("il provider AI configurato non accetta PDF");
    if (righe.filter((m) => m.mime?.startsWith("image/")).length > MAX_IMMAGINI_AI) throw new ErroreValidazione(`al massimo ${MAX_IMMAGINI_AI} immagini per richiesta`);
    const byte = righe.reduce((n, m) => n + (m.tipo === "testo" ? new TextEncoder().encode(m.testo ?? "").length : (m.dimensione ?? 0)), 0);
    if (byte > MAX_BYTE_AI) throw new ErroreValidazione(`i materiali scelti superano ${MAX_BYTE_AI / 1024 / 1024} MB`);

    const materiali = await prepara(c.env, righe, true);
    if (!(await prenotaChiamata(d))) interrompi(c, 429, `raggiunto il limite di ${MAX_CHIAMATE_AI_GIORNO} spiegazioni AI al giorno`);
    const r = await provider.spiega(costruisciPrompt(k, materiali));
    return salva(d, {
      id_carta: k.id_carta,
      testo: r.testo,
      testo_render: rendi(r.testo),
      fonte: "ai",
      modello: r.modello,
      impronta: await impronta(k, righe),
      materiali: righe.map((m) => m.id_materiale),
      creata_il: Date.now(),
    });
  });
  return c.json({ ...stato(c.env, valore, dalla_cache ? await obsoleta(d, k, valore) : false), dalla_cache });
});

// Prompt da copiare in una chat esterna: non chiama l'AI e non conta nel limite giornaliero.
router.post("/carte/:id/spiegazione/prompt", async (c) => {
  const { materiali: ids } = leggiRichiestaPrompt(await c.req.json());
  const d = db(c);
  const k = await leggiCarta(d, id(c));
  if (!k) return c.notFound();
  const righe = await materialiRichiesti(d, k, ids);
  const materiali = await prepara(c.env, righe, false);
  return c.json({
    prompt: promptTestuale(k, materiali),
    allegati: materiali.filter((m) => m.testo === undefined).map(({ id_materiale, titolo, mime }) => ({ id_materiale, titolo, mime })),
  });
});

export default router;
