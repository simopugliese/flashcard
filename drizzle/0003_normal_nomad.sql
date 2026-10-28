CREATE UNIQUE INDEX `argomento_nome_unico` ON `argomento` (`id_materia`,`nome_argomento`);--> statement-breakpoint
CREATE INDEX `carta_argomento_idx` ON `carta` (`id_argomento`);--> statement-breakpoint
CREATE UNIQUE INDEX `materia_nome_unico` ON `materia` (`nome_materia`);--> statement-breakpoint
CREATE INDEX `ripasso_prossimo_idx` ON `ripasso` (`prossimo_ripasso`);