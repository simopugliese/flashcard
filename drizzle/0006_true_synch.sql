CREATE TABLE `spiegazione` (
	`id_carta` integer PRIMARY KEY NOT NULL,
	`testo` text NOT NULL,
	`testo_render` text NOT NULL,
	`fonte` text NOT NULL,
	`modello` text,
	`impronta` text NOT NULL,
	`materiali` text NOT NULL,
	`creata_il` integer NOT NULL,
	FOREIGN KEY (`id_carta`) REFERENCES `carta`(`id_carta`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "spiegazione_fonte" CHECK("spiegazione"."fonte" IN ('manuale', 'ai'))
);
--> statement-breakpoint
CREATE TABLE `uso_ai` (
	`giorno` text PRIMARY KEY NOT NULL,
	`chiamate` integer NOT NULL
);
