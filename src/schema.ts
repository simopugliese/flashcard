import { sqliteTable, integer, text, real } from "drizzle-orm/sqlite-core";

export const materia = sqliteTable("materia", {
  id_materia: integer().primaryKey({ autoIncrement: true }),
  nome_materia: text().notNull(),
});

export const argomento = sqliteTable("argomento", {
  id_argomento: integer().primaryKey({ autoIncrement: true }),
  nome_argomento: text().notNull(),
  id_materia: integer().notNull().references(() => materia.id_materia, { onDelete: "cascade" }),
});

export const carta = sqliteTable("carta", {
  id_carta: integer().primaryKey({ autoIncrement: true }),
  domanda: text().notNull(),
  risposta: text().notNull(),
  // Opzioni sbagliate: se presenti la carta è a scelta multipla (la risposta corretta resta in `risposta`).
  opzioni: text({ mode: "json" }).$type<string[]>(),
  difficolta: integer().notNull().default(1),
  id_argomento: integer().notNull().references(() => argomento.id_argomento, { onDelete: "cascade" }),
});

export const ripasso = sqliteTable("ripasso", {
  id_carta: integer().primaryKey().references(() => carta.id_carta, { onDelete: "cascade" }),
  ultimo_ripasso: text(),
  prossimo_ripasso: text().notNull(),
  media_esito: real().notNull().default(0),
  numero_ripassi: integer().notNull().default(0),
});

export const invio_telegram = sqliteTable("invio_telegram", {
  id: integer().primaryKey(),
  prossimo_invio: integer().notNull(),
});
