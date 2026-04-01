import { vercelPreset } from "@vercel/react-router/vite";

/** @type {import("@react-router/dev/config").Config} */
const config = {
  presets: [vercelPreset()],
};

export default config;
