import type { NextConfig } from "next";
const config: NextConfig = {
  output: "export",
  trailingSlash: true,
  // API paths must reach the hosting-layer rewrite without slash redirects.
  skipTrailingSlashRedirect: true,
};
export default config;
