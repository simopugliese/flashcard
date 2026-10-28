import { sql } from "drizzle-orm";
import { sqliteTable, integer, text, real, index, uniqueIndex, check } from "drizzle-orm/sqlite-core";

export const materia = sqliteTable("materia", {
  id_materia: integer().primaryKey({ autoIncrement: true }),
  nome_materia: text().notNull(),
}, (t) => [uniqueIndex("materia_nome_unico").on(t.nome_materia)]);

export const argomento = sqliteTable("argomento", {
  id_argomento: integer().primaryKey({ autoIncrement: true }),
  nome_argomento: text().notNull(),
  id_materia: integer().notNull().references(() => materia.id_materia, { onDelete: "cascade" }),
}, (t) => [uniqueIndex("argomento_nome_unico").on(t.id_materia, t.nome_argomento)]);

export const carta = sqliteTable("carta", {
  id_carta: integer().primaryKey({ autoIncrement: true }),
  domanda: text().notNull(),
  risposta: text().notNull(),
  // Opzioni sbagliate: se presenti la carta è a scelta multipla (la risposta corretta resta in `risposta`).
  opzioni: text({ mode: "json" }).$type<string[]>(),
  // Il default del DB (1) non è usato: l'app imposta sempre la difficoltà (3 se omessa). Cambiarlo in SQLite
  // richiede di ricostruire la tabella, con il rischio di cancellare a cascata i ripassi.
  difficolta: integer().notNull().default(1),
  id_argomento: integer().notNull().references(() => argomento.id_argomento, { onDelete: "cascade" }),
}, (t) => [index("carta_argomento_idx").on(t.id_argomento)]);

export const ripasso = sqliteTable("ripasso", {
  id_carta: integer().primaryKey().references(() => carta.id_carta, { onDelete: "cascade" }),
  ultimo_ripasso: text(),
  prossimo_ripasso: text().notNull(),
  media_esito: real().notNull().default(0),
  numero_ripassi: integer().notNull().default(0),
}, (t) => [index("ripasso_prossimo_idx").on(t.prossimo_ripasso)]);

// Materiale di studio di un argomento o di una carta (esattamente uno dei due): una nota di testo/LaTeX oppure un file.
// I byte dei file stanno in R2, con chiave = `hash` (SHA-256): lo stesso contenuto caricato più volte occupa un solo oggetto.
export const materiale = sqliteTable("materiale", {
  id_materiale: integer().primaryKey({ autoIncrement: true }),
  tipo: text({ enum: ["testo", "file"] }).notNull(),
  titolo: text(),
  testo: text(),
  testo_render: text(),
  hash: text(),
  mime: text(),
  dimensione: integer(),
  id_argomento: integer().references(() => argomento.id_argomento, { onDelete: "cascade" }),
  id_carta: integer().references(() => carta.id_carta, { onDelete: "cascade" }),
  creato_il: integer().notNull(),
}, (t) => [
  check("materiale_un_proprietario", sql`(${t.id_argomento} IS NULL) <> (${t.id_carta} IS NULL)`),
  check("materiale_contenuto", sql`(${t.tipo} = 'testo' AND ${t.testo} IS NOT NULL) OR (${t.tipo} = 'file' AND ${t.hash} IS NOT NULL AND ${t.mime} IS NOT NULL)`),
  index("materiale_argomento_idx").on(t.id_argomento),
  index("materiale_carta_idx").on(t.id_carta),
  index("materiale_hash_idx").on(t.hash),
]);

export const invio_telegram =sqliteTable("invio_telegram", {
  id: integer().primaryKey(),
  prossimo_invio: integer().notNull(),
});
