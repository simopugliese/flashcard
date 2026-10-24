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
