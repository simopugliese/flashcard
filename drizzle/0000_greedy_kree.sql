CREATE TABLE `argomento` (
	`id_argomento` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`nome_argomento` text NOT NULL,
	`id_materia` integer NOT NULL,
	FOREIGN KEY (`id_materia`) REFERENCES `materia`(`id_materia`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `carta` (
	`id_carta` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domanda` text NOT NULL,
	`risposta` text NOT NULL,
	`difficolta` integer DEFAULT 1 NOT NULL,
	`id_argomento` integer NOT NULL,
	FOREIGN KEY (`id_argomento`) REFERENCES `argomento`(`id_argomento`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `materia` (
	`id_materia` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`nome_materia` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ripasso` (
	`id_carta` integer PRIMARY KEY NOT NULL,
	`ultimo_ripasso` text,
	`prossimo_ripasso` text NOT NULL,
	`media_esito` real DEFAULT 0 NOT NULL,
	`numero_ripassi` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`id_carta`) REFERENCES `carta`(`id_carta`) ON UPDATE no action ON DELETE cascade
);
