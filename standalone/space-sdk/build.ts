import tailwind from "bun-plugin-tailwind";
export async function buildClient() {
  const r = await Bun.build({
    entrypoints: ["./client/index.html"],
    outdir: "./client/dist",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [tailwind],
  });
  if (!r.success) { console.error(r.logs); process.exit(1); }
}
