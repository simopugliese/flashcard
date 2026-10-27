import type { DrizzleD1Database } from "drizzle-orm/d1";
import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { argomento, carta, ripasso } from "./schema";
import type { FiltroRipasso } from "./validazione";

type Db = DrizzleD1Database;
type Ripasso = typeof ripasso.$inferSelect;

// Date in ora italiana (YYYY-MM-DD). Si sommano giorni di calendario, quindi il cambio dell'ora legale non conta.
const giornoRoma = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" });
export const oggi = (giorni = 0) => {
  const d = new Date(giornoRoma.format(Date.now())); // mezzanotte UTC del giorno italiano
  d.setUTCDate(d.getUTCDate() + giorni);
  return d.toISOString().slice(0, 10);
};

// Modo "scadenza": carte da ripassare oggi; "anticipo": solo quelle non ancora in scadenza; "tutte": senza filtro sulla data.
export const carteDaRipassare = (d: Db, { idMateria, argomenti, modo, casuale, limite }: FiltroRipasso = { modo: "scadenza", casuale: false }) => {
  const data = modo === "scadenza" ? lte(ripasso.prossimo_ripasso, oggi()) : modo === "anticipo" ? gt(ripasso.prossimo_ripasso, oggi()) : undefined;
  const ordine = casuale ? [sql`random()`] : [ripasso.prossimo_ripasso, desc(carta.difficolta), ripasso.media_esito];
  const q = d
    .select({ carta, ripasso })
    .from(carta)
    .innerJoin(ripasso, eq(ripasso.id_carta, carta.id_carta))
    .innerJoin(argomento, eq(argomento.id_argomento, carta.id_argomento))
    .where(and(data, idMateria ? eq(argomento.id_materia, idMateria) : undefined, argomenti ? inArray(carta.id_argomento, argomenti) : undefined))
    .orderBy(...ordine);
  return limite ? q.limit(limite) : q;
};

// Tetto all'intervallo: evita date assurde quando media e numero di ripassi crescono.
const GIORNI_MAX = 365;

// Nuovo stato del ripasso dopo un voto (funzione pura, senza accesso al database).
export const calcolaRipasso = (r: Ripasso, voto: number, difficolta: number) => {
  const n = r.numero_ripassi + 1;
  const media = (r.media_esito * r.numero_ripassi + voto) / n;
  // La difficoltà 3 è neutra: ogni punto in meno allunga l'intervallo del 20%, ogni punto in più lo accorcia.
  const fattore = 1 + (3 - difficolta) * 0.2;
  const giorni = voto < 3 ? 1 : Math.min(GIORNI_MAX, Math.max(1, Math.ceil(media * n * fattore)));
  // Un ripasso fatto in anticipo con un buon voto non deve accorciare la scadenza già fissata.
  const calcolato = oggi(giorni);
  const prossimo = voto >= 3 && r.prossimo_ripasso > calcolato ? r.prossimo_ripasso : calcolato;
  return { ultimo_ripasso: oggi(), prossimo_ripasso: prossimo, media_esito: media, numero_ripassi: n };
};

// Aggiorna il ripasso solo se nel frattempo nessun altro voto l'ha modificato:
// restituisce undefined se il voto arriva tardi (doppio click, carta già ripassata altrove).
export const registraVoto = async (d: Db, r: Ripasso, voto: number, difficolta: number) => {
  const [nuovo] = await d
    .update(ripasso)
    .set(calcolaRipasso(r, voto, difficolta))
    .where(and(eq(ripasso.id_carta, r.id_carta), eq(ripasso.numero_ripassi, r.numero_ripassi)))
    .returning();
  return nuovo as Ripasso | undefined;
};
