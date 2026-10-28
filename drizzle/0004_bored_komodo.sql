CREATE TABLE `materiale` (
	`id_materiale` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tipo` text NOT NULL,
	`titolo` text,
	`testo` text,
	`testo_render` text,
	`hash` text,
	`mime` text,
	`dimensione` integer,
	`id_argomento` integer,
	`id_carta` integer,
	`creato_il` integer NOT NULL,
	FOREIGN KEY (`id_argomento`) REFERENCES `argomento`(`id_argomento`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`id_carta`) REFERENCES `carta`(`id_carta`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "materiale_un_proprietario" CHECK(("materiale"."id_argomento" IS NULL) <> ("materiale"."id_carta" IS NULL)),
	CONSTRAINT "materiale_contenuto" CHECK(("materiale"."tipo" = 'testo' AND "materiale"."testo" IS NOT NULL) OR ("materiale"."tipo" = 'file' AND "materiale"."hash" IS NOT NULL AND "materiale"."mime" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `materiale_argomento_idx` ON `materiale` (`id_argomento`);--> statement-breakpoint
CREATE INDEX `materiale_carta_idx` ON `materiale` (`id_carta`);--> statement-breakpoint
CREATE INDEX `materiale_hash_idx` ON `materiale` (`hash`);