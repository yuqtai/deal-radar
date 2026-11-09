import { QueryClient } from "@tanstack/react-query";
import type { z } from "zod";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyActions = Record<string, { request: z.ZodTypeAny; response: z.ZodTypeAny; [k: string]: any }>;

export type ActionClient<A extends AnyActions> = {
  [K in keyof A]: (args: z.input<A[K]["request"]>) => Promise<z.output<A[K]["response"]>>;
};

export type ApiRequest<C, K extends keyof C> = C[K] extends (a: infer R) => unknown ? R : never;
export type ApiResponse<C, K extends keyof C> = C[K] extends (a: never) => Promise<infer R> ? R : never;

export function createActionClient<A extends AnyActions>(): ActionClient<A> {
  return new Proxy({} as ActionClient<A>, {
    get(_t, action: string) {
      return async (args: unknown) => {
        const res = await fetch("./actions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, args }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        return body;
      };
    },
  });
}

export const spaceQueryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: true, staleTime: 30_000 } },
});

export function SafeAreaTopScrim({ backgroundColor }: { backgroundColor: string }) {
  return (
    <div
      aria-hidden="true"
      style={{ position: "fixed", inset: "0 0 auto 0", height: "env(safe-area-inset-top)", background: backgroundColor, zIndex: 50 }}
    />
  );
}
