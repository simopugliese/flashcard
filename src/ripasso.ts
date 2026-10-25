import type { DrizzleD1Database } from "drizzle-orm/d1";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { argomento, carta, ripasso } from "./schema";

type Db = DrizzleD1Database;
type Ripasso = typeof ripasso.$inferSelect;

export const oggi = (giorni = 0) => new Date(Date.now() + giorni * 86400000).toISOString().slice(0, 10);

export const carteDaRipassare = (d: Db, idMateria?: number, argomenti?: number[]) =>
  d
    .select({ carta, ripasso })
    .from(carta)
    .innerJoin(ripasso, eq(ripasso.id_carta, carta.id_carta))
    .innerJoin(argomento, eq(argomento.id_argomento, carta.id_argomento))
    .where(
      and(
        lte(ripasso.prossimo_ripasso, oggi()),
        idMateria ? eq(argomento.id_materia, idMateria) : undefined,
        argomenti ? inArray(carta.id_argomento, argomenti) : undefined,
      ),
    )
    .orderBy(ripasso.prossimo_ripasso, desc(carta.difficolta), ripasso.media_esito);

// Aggiorna il ripasso solo se nel frattempo nessun altro voto l'ha modificato:
// restituisce undefined se il voto arriva tardi (doppio click, carta già ripassata altrove).
export const registraVoto = async (d: Db, r: Ripasso, voto: number, difficolta: number) => {
  const n = r.numero_ripassi + 1;
  const media = (r.media_esito * r.numero_ripassi + voto) / n;
  // La difficoltà 3 è neutra: ogni punto in meno allunga l'intervallo del 20%, ogni punto in più lo accorcia.
  const fattore = 1 + (3 - difficolta) * 0.2;
  const giorni = voto < 3 ? 1 : Math.max(1, Math.ceil(media * n * fattore));
  const [nuovo] = await d
    .update(ripasso)
    .set({ ultimo_ripasso: oggi(), prossimo_ripasso: oggi(giorni), media_esito: media, numero_ripassi: n })
    .where(and(eq(ripasso.id_carta, r.id_carta), eq(ripasso.numero_ripassi, r.numero_ripassi)))
    .returning();
  return nuovo as Ripasso | undefined;
};
