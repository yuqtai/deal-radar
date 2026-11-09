// 本地开发用 @hatch/space-sdk 替身（仅实现本项目用到的 API）。
import { z } from "zod";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { Database } from "bun:sqlite";

export { z };

export interface Ctx {
  db<S extends Record<string, unknown>>(): BunSQLiteDatabase<S>;
  invalidateQueries(): void;
}

export interface ActionDef<Req extends z.ZodTypeAny, Res extends z.ZodTypeAny> {
  description: string;
  request: Req;
  response: Res;
  handler(ctx: Ctx, args: z.infer<Req>): Promise<z.infer<Res>>;
}

export function defineAction<Req extends z.ZodTypeAny, Res extends z.ZodTypeAny>(
  def: ActionDef<Req, Res>,
): ActionDef<Req, Res> {
  return def;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ActionsModule = Record<string, ActionDef<any, any>>;

export function makeCtx(sqlite: Database): Ctx {
  const db = drizzle(sqlite);
  return {
    db: () => db as never,
    invalidateQueries() {},
  };
}
