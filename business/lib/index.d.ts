/**
 * Project collaboration business module — plugin entry point.
 *
 * One plugin, one SQLite database, no UI and no permission model (see docs/adr/).
 * All writes flow tool → service → sqlite; there is no other write path.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "project-collaboration";
export interface Config {
    /** SQLite file, relative to the session's working directory. */
    readonly databasePath: string;
    /** Root directory for uploaded materials and produced results. */
    readonly fileRoot: string;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
